import type { Store } from '../db/store.js';
import {
  createBackend,
  modelCached,
  presetFor,
  runtimeInstalled,
  type EmbeddingBackend,
  type ModelPreset,
} from './model.js';

export interface EmbedderOpts {
  enabled: boolean;
  download: boolean;
  /** 'code' | 'fast' | raw HF model id. */
  model: string;
  /** Test hook: replaces runtime install + model download entirely. */
  backendFactory?: (preset: ModelPreset) => Promise<EmbeddingBackend | null>;
}

export type EmbedderPhase =
  | 'disabled'
  | 'idle'       // chunks may be pending; model not local; waiting for first semantic_search
  | 'acquiring'  // installing runtime / downloading model / loading it
  | 'embedding'  // working through the backlog
  | 'ready'      // every chunk embedded
  | 'unavailable'// downloads disabled and nothing cached
  | 'error';

const BATCH_SIZE = 24;
const IDLE_DISPOSE_MS = 5 * 60 * 1000;
const MAX_ERRORS = 3;

/**
 * Owns the embedding model and keeps chunk vectors current in the background.
 * The model is only ever downloaded on an explicit semantic_search; once it
 * is cached locally, later sessions resume embedding on startup by themselves.
 */
export class Embedder {
  phase: EmbedderPhase;
  note: string | null = null;

  private readonly preset: ModelPreset;
  private backend: EmbeddingBackend | null = null;
  private backendPromise: Promise<EmbeddingBackend | null> | null = null;
  private started = false;
  private stopped = false;
  private errors = 0;
  private wakeLoop: (() => void) | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Serializes all extractor calls (batch loop vs query embeds). */
  private embedChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly opts: EmbedderOpts,
  ) {
    this.preset = presetFor(opts.model);
    this.phase = opts.enabled ? 'idle' : 'disabled';
  }

  private get modelLocal(): boolean {
    return Boolean(this.opts.backendFactory) || (runtimeInstalled() && modelCached(this.preset));
  }

  /**
   * startup: resume embedding only when everything is already cached —
   * never triggers the big first-time download. query: may download.
   */
  activate(origin: 'startup' | 'query'): void {
    if (!this.opts.enabled || this.stopped || this.started) return;
    if (origin === 'startup' && !this.modelLocal) return;
    if (!this.opts.download && !this.modelLocal) {
      this.phase = 'unavailable';
      this.note = 'downloads disabled and no cached model';
      return;
    }
    this.started = true;
    void this.loop();
  }

  /** New chunks may exist (watcher batch applied / sweep finished). */
  nudge(): void {
    if (this.wakeLoop) {
      this.wakeLoop();
      this.wakeLoop = null;
    }
  }

  /**
   * Embed one query string. Waits only when the model is already local
   * (seconds); a needed download runs in the background instead and this
   * returns null so the caller can answer keyword-only right away.
   */
  async queryVector(text: string): Promise<Float32Array | null> {
    if (!this.opts.enabled || this.phase === 'error') return null;
    if (!this.backend && !this.modelLocal) {
      this.activate('query');
      return null;
    }
    const backend = await this.ensureBackend();
    if (!backend) return null;
    this.activate('query');
    const run = this.embedChain.then(() => backend.embed([this.preset.queryPrefix + text]));
    this.embedChain = run.catch(() => undefined);
    const [vec] = await run;
    return vec ?? null;
  }

  statusLines(): string[] {
    if (!this.opts.enabled) return ['embeddings: disabled'];
    const { chunks, embedded } = this.store.embeddingStats();
    const model = `${this.preset.name} (${this.preset.hfId})`;
    const accel = this.store.vecAccel ? 'sqlite-vec' : 'js-scan';
    const head = `embeddings: ${embedded}/${chunks} chunks embedded, model ${model}, ${accel}`;
    switch (this.phase) {
      case 'idle':
        return [`${head} — model not downloaded yet; first semantic_search fetches it`];
      case 'acquiring':
        return [`${head} — downloading/loading model…`];
      case 'embedding':
        return [`${head} — embedding backlog…`];
      case 'unavailable':
        return [`${head} — unavailable: ${this.note ?? ''}`];
      case 'error':
        return [`${head} — error: ${this.note ?? ''}`];
      default:
        return [head];
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.nudge();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const backend = this.backend;
    this.backend = null;
    if (backend) await backend.dispose().catch(() => undefined);
  }

  private ensureBackend(): Promise<EmbeddingBackend | null> {
    if (this.backend) return Promise.resolve(this.backend);
    this.backendPromise ??= (async () => {
      const wasLocal = this.modelLocal;
      if (!wasLocal) this.phase = 'acquiring';
      try {
        const backend = this.opts.backendFactory
          ? await this.opts.backendFactory(this.preset)
          : await createBackend(this.preset, { download: this.opts.download });
        if (!backend) {
          this.phase = 'unavailable';
          this.note = this.opts.download
            ? 'runtime install or model download failed'
            : 'downloads disabled and no cached model';
          return null;
        }
        // switching models invalidates every stored vector
        const prev = this.store.getMeta('embedding_model');
        if (prev !== backend.hfId) {
          if (prev) {
            this.store.resetEmbeddings();
            this.nudge(); // the loop may be idle with a suddenly-full backlog
          }
          this.store.setMeta('embedding_model', backend.hfId);
        }
        this.backend = backend;
        return backend;
      } catch (err) {
        this.phase = 'error';
        this.note = err instanceof Error ? err.message : String(err);
        return null;
      } finally {
        this.backendPromise = null;
      }
    })();
    return this.backendPromise;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      // a configured model different from the stored one is work in itself:
      // loading it (via ensureBackend) resets every vector
      const prev = this.store.getMeta('embedding_model');
      const modelStale = prev !== undefined && prev !== this.preset.hfId && !this.backend;
      const pending = modelStale ? [] : this.store.pendingChunks(BATCH_SIZE);
      if (!modelStale && pending.length === 0) {
        this.phase = 'ready';
        this.scheduleIdleDispose();
        await new Promise<void>((resolve) => {
          this.wakeLoop = resolve;
        });
        continue;
      }
      const backend = await this.ensureBackend();
      if (!backend) return; // phase/note already set
      if (modelStale) continue; // meta synced, vectors reset — re-read the backlog

      this.phase = 'embedding';
      try {
        const run = this.embedChain.then(() => backend.embed(pending.map((c) => c.content)));
        this.embedChain = run.catch(() => undefined);
        const vectors = await run;
        this.store.writeChunkVectors(
          pending.map((c, i) => ({ chunkId: c.id, vector: vectors[i]! })),
        );
        if (backend.dims > 0) this.store.setMeta('embedding_dims', String(backend.dims));
        this.errors = 0;
      } catch (err) {
        this.note = err instanceof Error ? err.message : String(err);
        if (++this.errors >= MAX_ERRORS) {
          this.phase = 'error';
          return;
        }
      }
      // stay responsive: the MCP server shares this event loop
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private scheduleIdleDispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const backend = this.backend;
      this.backend = null;
      if (backend) void backend.dispose().catch(() => undefined);
    }, IDLE_DISPOSE_MS);
    this.idleTimer.unref?.();
  }
}
