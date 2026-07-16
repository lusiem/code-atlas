import type { LanguageId } from '../types.js';
import { defaultCacheDir, ensureServer } from './acquire.js';
import { LspClient, type LaunchSpec } from './client.js';
import { REGISTRY, type ServerSpec } from './registry.js';

export type ServerState =
  | 'available'   // not started yet (or idle-stopped); will spawn on demand
  | 'starting'
  | 'running'
  | 'unavailable' // no binary found and not acquirable
  | 'failed';     // crashed repeatedly — structural-only this session

interface Entry {
  spec: ServerSpec;
  state: ServerState;
  client: LspClient | null;
  startPromise: Promise<LspClient | null> | null;
  launch: LaunchSpec | null;
  crashes: number;
  idleTimer: NodeJS.Timeout | null;
  note: string | null;
}

const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
const MAX_CRASHES = 3;
/** How long a tool call waits for a server start before answering structurally. */
const START_BUDGET_MS = 8000;

/**
 * Lazily spawns one language server per registry entry per workspace and
 * hands out clients. Every failure path degrades to null — callers fall back
 * to the structural index and the state is reported in index_status.
 */
export class LspManager {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly rootDir: string,
    private readonly opts: { enabled: boolean; download: boolean; cacheDir?: string },
    specs: ServerSpec[] = REGISTRY,
  ) {
    for (const spec of specs) {
      this.entries.set(spec.id, {
        spec, state: 'available', client: null, startPromise: null,
        launch: null, crashes: 0, idleTimer: null, note: null,
      });
    }
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** A ready client for this language, or null (disabled/unavailable/failed). */
  async clientFor(lang: LanguageId): Promise<LspClient | null> {
    if (!this.opts.enabled) return null;
    const entry = [...this.entries.values()].find((e) => e.spec.languages.includes(lang));
    if (!entry || entry.state === 'unavailable' || entry.state === 'failed') return null;

    if (entry.client?.alive) {
      this.touch(entry);
      return entry.client;
    }
    entry.startPromise ??= this.startEntry(entry).finally(() => {
      entry.startPromise = null;
    });
    // Wait briefly so a warm server still answers the first query — but a
    // cold acquisition (50 MB download, JVM boot) keeps going in the
    // background while this query falls back to the structural index.
    // MCP clients time tool calls out at 60 s; never ride close to that.
    const budget = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), START_BUDGET_MS).unref();
    });
    const winner = await Promise.race([entry.startPromise, budget]);
    return winner === 'timeout' ? null : winner;
  }

  /** An already-running client for this language — never starts or waits for one. */
  runningClientFor(lang: LanguageId): LspClient | null {
    if (!this.opts.enabled) return null;
    const entry = [...this.entries.values()].find((e) => e.spec.languages.includes(lang));
    if (!entry?.client?.alive) return null;
    this.touch(entry);
    return entry.client;
  }

  private async startEntry(entry: Entry): Promise<LspClient | null> {
    entry.state = 'starting';
    try {
      entry.launch ??=
        entry.spec.launch ??
        (entry.spec.attach
          ? { command: '', args: [], tcp: entry.spec.attach }
          : await ensureServer(entry.spec, {
              download: this.opts.download,
              cacheDir: this.opts.cacheDir ?? defaultCacheDir(),
              rootDir: this.rootDir,
            }));
      if (!entry.launch) {
        entry.state = 'unavailable';
        entry.note = entry.spec.installHint;
        return null;
      }
      const client = await LspClient.start(entry.launch, this.rootDir, entry.spec.languageIds);
      client.onUnexpectedExit = () => this.onCrash(entry);
      entry.client = client;
      entry.state = 'running';
      entry.note = null;
      this.touch(entry);
      return client;
    } catch (err) {
      entry.note = entry.spec.attach
        ? entry.spec.installHint
        : err instanceof Error
          ? err.message
          : String(err);
      return this.onCrash(entry), null;
    }
  }

  private onCrash(entry: Entry): void {
    entry.client = null;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    // attach servers come and go with their host app (the Godot editor);
    // an unreachable or dropped connection is normal — retry on demand
    if (entry.spec.attach) {
      entry.state = 'available';
      return;
    }
    entry.crashes++;
    entry.state = entry.crashes >= MAX_CRASHES ? 'failed' : 'available';
    if (entry.state === 'failed') {
      console.error(`[code-atlas] ${entry.spec.id} failed ${entry.crashes}x — structural-only for this session`);
    }
  }

  private touch(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      void entry.client?.dispose();
      entry.client = null;
      entry.state = 'available';
    }, IDLE_SHUTDOWN_MS);
    entry.idleTimer.unref();
  }

  /** Forward watcher batches so servers reload changed files. */
  filesChanged(relPaths: string[]): void {
    for (const entry of this.entries.values()) {
      if (entry.client?.alive) entry.client.filesChanged(relPaths);
    }
  }

  /** Lines for index_status. */
  statusLines(): string[] {
    if (!this.opts.enabled) return ['lsp: disabled'];
    const lines: string[] = [];
    for (const entry of this.entries.values()) {
      const langs = entry.spec.languages.join('/');
      let detail: string;
      switch (entry.state) {
        case 'running': detail = 'running'; break;
        case 'starting': detail = 'starting'; break;
        case 'available':
          detail = entry.crashes > 0
            ? `idle (${entry.crashes} crashes)`
            : entry.spec.attach && entry.note
              ? `not connected — ${entry.note}`
              : 'on demand';
          break;
        case 'failed': detail = `failed — structural-only (${entry.note ?? 'crashed repeatedly'})`; break;
        case 'unavailable': detail = `not found — ${entry.note ?? 'not installed'}`; break;
      }
      lines.push(`  ${entry.spec.id} (${langs}): ${detail}`);
    }
    return [`lsp (${this.rootDir}):`, ...lines];
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((e) => {
        if (e.idleTimer) clearTimeout(e.idleTimer);
        return e.client?.dispose();
      }),
    );
  }
}
