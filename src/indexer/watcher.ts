import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import ignoreFactory, { type Ignore } from 'ignore';
import type { AtlasConfig } from '../config.js';
import { assetForPath } from '../engines/detect.js';
import { languageForPath } from '../languages.js';
import { CONFIG_FILE_NAME } from '../config.js';
import type { Indexer } from './indexer.js';
import { DEFAULT_IGNORES } from './scanner.js';

export interface WatcherStatus {
  watching: boolean;
  /** Paths queued for the next debounce flush. */
  pending: number;
  /** Batches applied since start. */
  batches: number;
  lastBatchAt: number | null;
  lastBatchFiles: number;
}

/**
 * Debounced filesystem watcher feeding the indexer. Mirrors the scanner's
 * ignore semantics (built-in ignores + config excludes + nested .gitignore
 * chain) so watch batches and sweeps agree on what is indexable. A change to
 * a .gitignore or the config file falls back to a full sweep, since it can
 * flip arbitrary files in or out of scope.
 */
export class Watcher {
  readonly status: WatcherStatus = {
    watching: false,
    pending: 0,
    batches: 0,
    lastBatchAt: null,
    lastBatchFiles: 0,
  };

  private fsw: FSWatcher | null = null;
  private readonly pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private needsFullSweep = false;
  private readonly rootIg: Ignore;
  /** dir relPath -> matcher for that dir's .gitignore (null = no .gitignore). */
  private readonly igCache = new Map<string, Ignore | null>();
  private readonly debounceMs: number;
  private readonly onBatch: ((paths: string[]) => void) | undefined;

  constructor(
    private readonly config: AtlasConfig,
    private readonly indexer: Indexer,
    opts: { debounceMs?: number; onBatch?: (paths: string[]) => void } = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.onBatch = opts.onBatch;
    this.rootIg = ignoreFactory().add(DEFAULT_IGNORES).add(this.config.exclude);
  }

  start(): void {
    if (this.fsw) return;
    this.fsw = watch(this.config.root, {
      ignoreInitial: true,
      ignored: (path, stats) => this.isIgnoredAbs(path, stats?.isDirectory()),
    });
    for (const event of ['add', 'change', 'unlink'] as const) {
      this.fsw.on(event, (absPath: string) => this.onFsEvent(absPath));
    }
    this.fsw.on('error', (err) => {
      console.error('[code-atlas] watcher error:', err instanceof Error ? err.message : err);
    });
    this.status.watching = true;
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.fsw?.close();
    this.fsw = null;
    this.status.watching = false;
    await this.flushing;
  }

  /** Wait for queued events to be flushed and applied (used by tests). */
  async settle(): Promise<void> {
    while (this.timer || this.flushing || this.pending.size > 0) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
        await this.flush();
      }
      await (this.flushing ?? Promise.resolve());
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private onFsEvent(absPath: string): void {
    const rel = toRel(this.config.root, absPath);
    if (rel === null) return;
    const base = rel.split('/').pop()!;
    if (base === '.gitignore' || base === CONFIG_FILE_NAME) {
      this.needsFullSweep = true;
      this.igCache.clear();
    } else {
      if (!languageForPath(rel) && !assetForPath(rel)) return;
      if (this.isIgnoredRel(rel, false)) return;
      this.pending.add(rel);
    }
    this.status.pending = this.pending.size;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      // a batch is being applied; re-arm the timer to pick up the rest after
      this.timer ??= setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.debounceMs);
      return;
    }
    const paths = [...this.pending];
    this.pending.clear();
    this.status.pending = 0;
    const fullSweep = this.needsFullSweep;
    this.needsFullSweep = false;
    if (!fullSweep && paths.length === 0) return;

    this.flushing = (fullSweep ? this.indexer.run() : this.indexer.applyChanges(paths))
      .catch((err) => {
        console.error('[code-atlas] watch batch failed:', err instanceof Error ? err.message : err);
      })
      .finally(() => {
        this.flushing = null;
        this.status.batches++;
        this.status.lastBatchAt = Date.now();
        this.status.lastBatchFiles = fullSweep ? -1 : paths.length;
        this.onBatch?.(paths);
      });
    await this.flushing;
  }

  private isIgnoredAbs(absPath: string, isDir: boolean | undefined): boolean {
    const rel = toRel(this.config.root, absPath);
    if (rel === null) return true;
    if (rel === '') return false; // the root itself
    let dir = isDir;
    if (dir === undefined) {
      try {
        dir = statSync(absPath).isDirectory();
      } catch {
        dir = false;
      }
    }
    return this.isIgnoredRel(rel, dir);
  }

  /** Same semantics as the scanner: root matcher + each ancestor .gitignore, scoped. */
  private isIgnoredRel(relPath: string, isDir: boolean): boolean {
    const probe = isDir ? `${relPath}/` : relPath;
    if (this.rootIg.ignores(probe)) return true;

    const segments = relPath.split('/');
    let base = '';
    for (let i = 0; i < segments.length; i++) {
      const ig = this.gitignoreFor(base);
      if (ig) {
        const scoped = base === '' ? probe : probe.slice(base.length + 1);
        if (scoped !== '' && ig.ignores(scoped)) return true;
      }
      base = base === '' ? segments[i]! : `${base}/${segments[i]!}`;
    }
    return false;
  }

  private gitignoreFor(dirRel: string): Ignore | null {
    let ig = this.igCache.get(dirRel);
    if (ig !== undefined) return ig;
    try {
      const abs = dirRel === '' ? `${this.config.root}/.gitignore` : `${this.config.root}/${dirRel}/.gitignore`;
      ig = ignoreFactory().add(readFileSync(abs, 'utf8'));
    } catch {
      ig = null;
    }
    this.igCache.set(dirRel, ig);
    return ig;
  }
}

/** Root-relative forward-slash path, or null when outside the root. */
function toRel(root: string, absPath: string): string | null {
  const rel = relative(root, absPath).replaceAll('\\', '/');
  if (rel.startsWith('..') || rel.includes(':')) return null;
  return rel;
}
