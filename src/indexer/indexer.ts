import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AtlasConfig } from '../config.js';
import type { LanguageId } from '../types.js';
import type { Store } from '../db/store.js';
import { extractorFor } from '../parsing/registry.js';
import { extractFile } from '../parsing/extractor.js';
import { scanWorkspace } from './scanner.js';

export interface IndexProgress {
  state: 'idle' | 'indexing' | 'ready' | 'error';
  totalFiles: number;
  processedFiles: number;
  changedFiles: number;
  removedFiles: number;
  errors: Array<{ path: string; message: string }>;
  startedAt: number | null;
  finishedAt: number | null;
}

export class Indexer {
  readonly progress: IndexProgress = {
    state: 'idle',
    totalFiles: 0,
    processedFiles: 0,
    changedFiles: 0,
    removedFiles: 0,
    errors: [],
    startedAt: null,
    finishedAt: null,
  };

  private running: Promise<void> | null = null;

  constructor(
    private readonly config: AtlasConfig,
    private readonly store: Store,
  ) {}

  /** Kick off (or join) a full incremental sweep: index changed files, drop deleted ones. */
  run(): Promise<void> {
    this.running ??= this.sweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async sweep(): Promise<void> {
    const p = this.progress;
    p.state = 'indexing';
    p.startedAt = Date.now();
    p.finishedAt = null;
    p.processedFiles = 0;
    p.changedFiles = 0;
    p.removedFiles = 0;
    p.errors = [];

    try {
      const scanned = scanWorkspace(this.config);
      p.totalFiles = scanned.length;

      const seen = new Set<string>();
      for (const file of scanned) {
        seen.add(file.relPath);
        try {
          await this.indexOne(file.relPath, file.absPath, file.lang, file.size, file.mtimeMs);
        } catch (err) {
          if (p.errors.length < 50) {
            p.errors.push({ path: file.relPath, message: err instanceof Error ? err.message : String(err) });
          }
        }
        p.processedFiles++;
        // yield to the event loop so MCP requests stay responsive mid-index
        if (p.processedFiles % 20 === 0) await new Promise((r) => setImmediate(r));
      }

      for (const known of this.store.listFiles()) {
        if (!seen.has(known.path)) {
          this.store.removeFile(known.path);
          p.removedFiles++;
        }
      }
      p.state = 'ready';
    } catch (err) {
      p.state = 'error';
      p.errors.push({ path: '', message: err instanceof Error ? err.message : String(err) });
    } finally {
      p.finishedAt = Date.now();
    }
  }

  private async indexOne(
    relPath: string,
    absPath: string,
    lang: LanguageId,
    size: number,
    mtimeMs: number,
  ): Promise<void> {
    const extractor = extractorFor(lang);
    if (!extractor) return;

    const source = readFileSync(absPath, 'utf8');
    const hash = createHash('sha1').update(source).digest('hex');
    const existing = this.store.getFileByPath(relPath);
    if (existing && existing.hash === hash) return;

    const extraction = await extractFile(extractor, source);
    this.store.replaceFile({ path: relPath, lang, hash, size, mtimeMs }, extraction);
    this.progress.changedFiles++;
  }
}
