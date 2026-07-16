import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AtlasConfig } from '../config.js';
import type { LanguageId } from '../types.js';
import type { Store } from '../db/store.js';
import { extractorFor } from '../parsing/registry.js';
import { extractFile } from '../parsing/extractor.js';
import { languageForPath } from '../languages.js';
import { buildChunks } from '../embeddings/chunker.js';
import { assetForPath, type AssetInfo } from '../engines/detect.js';
import { extractAssetRefs } from '../engines/registry.js';
import { affectedFilesFor, resolveWorkspace, type ResolveStats } from '../graph/resolver.js';
import { isTestPath } from '../analysis/testish.js';
import { frameworkForFile } from '../frameworks/detect.js';
import { extractRoutes } from '../frameworks/registry.js';
import { FileRouteDetector, extractFileRoutes, isMarkerPath } from '../frameworks/fileroutes.js';
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
  /** Result of the last cross-file resolution pass, if one has run. */
  resolve: ResolveStats | null;
}

/** State gathered across one sweep or watch batch, feeding the resolve scope. */
interface Batch {
  /** True when a resolution pass already exists (incremental is possible). */
  warm: boolean;
  /**
   * True when a previous session committed file rows but crashed before its
   * resolution pass — blast radius unknown, so this batch resolves fully.
   */
  staleResolve: boolean;
  changedFileIds: number[];
  /** Symbol names defined by the pre-change version of changed/removed files. */
  oldSymbolNames: Set<string>;
  /** Files that imported a file removed in this batch (captured pre-delete). */
  importersOfRemoved: Set<number>;
  removed: number;
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
    resolve: null,
  };

  /** All index mutations run through this chain: sweeps and watch batches never overlap. */
  private chain: Promise<void> = Promise.resolve();
  private pendingSweep: Promise<void> | null = null;
  private readonly fileRoutes: FileRouteDetector;

  constructor(
    private readonly config: AtlasConfig,
    private readonly store: Store,
  ) {
    this.fileRoutes = new FileRouteDetector(config.root);
  }

  /** Kick off (or join) a full incremental sweep: index changed files, drop deleted ones. */
  run(): Promise<void> {
    this.pendingSweep ??= this.schedule(() => this.sweep()).finally(() => {
      this.pendingSweep = null;
    });
    return this.pendingSweep;
  }

  /**
   * Apply a watcher batch: paths (root-relative, forward slashes) that were
   * added, changed, or deleted. Missing files are dropped from the index;
   * present ones are (re)indexed by content hash.
   */
  applyChanges(relPaths: string[]): Promise<void> {
    return this.schedule(() => this.applyBatch(relPaths));
  }

  private schedule(job: () => Promise<void>): Promise<void> {
    const run = this.chain.then(job, job);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private newBatch(): Batch {
    return {
      warm: Boolean(this.store.getMeta('resolved_at')),
      staleResolve: this.store.getMeta('resolve_dirty') === '1',
      changedFileIds: [],
      oldSymbolNames: new Set(),
      importersOfRemoved: new Set(),
      removed: 0,
    };
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
    this.fileRoutes.invalidate();

    try {
      const { files: scanned, assets } = scanWorkspace(this.config);
      p.totalFiles = scanned.length;
      const batch = this.newBatch();

      const seen = new Set<string>();
      for (const file of scanned) {
        seen.add(file.relPath);
        try {
          await this.indexOne(file.relPath, file.absPath, file.lang, file.size, file.mtimeMs, batch);
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
        if (!seen.has(known.path)) this.removeOne(known.path, known.id, batch);
      }

      const seenAssets = new Set<string>();
      for (const asset of assets) {
        seenAssets.add(asset.relPath);
        try {
          this.indexAsset(asset.relPath, asset.absPath, asset.info);
        } catch (err) {
          if (p.errors.length < 50) {
            p.errors.push({ path: asset.relPath, message: err instanceof Error ? err.message : String(err) });
          }
        }
      }
      for (const known of this.store.listAssets()) {
        if (!seenAssets.has(known.path)) this.store.removeAsset(known.path);
      }

      await this.resolveBatch(batch);
      p.state = 'ready';
    } catch (err) {
      p.state = 'error';
      p.errors.push({ path: '', message: err instanceof Error ? err.message : String(err) });
    } finally {
      p.finishedAt = Date.now();
    }
  }

  private async applyBatch(relPaths: string[]): Promise<void> {
    const p = this.progress;
    const prevState = p.state;
    p.state = 'indexing';
    const batch = this.newBatch();
    // a framework config appearing/vanishing flips file-route detection; files
    // indexed before the marker existed stay as-is until their next reindex
    if (relPaths.some(isMarkerPath)) this.fileRoutes.invalidate();

    try {
      for (const rel of relPaths) {
        const abs = join(this.config.root, rel);
        let stat;
        try {
          stat = statSync(abs);
        } catch {
          stat = null;
        }
        const assetInfo = assetForPath(rel);
        if (!stat?.isFile()) {
          const existing = this.store.getFileByPath(rel);
          if (existing) this.removeOne(rel, existing.id, batch);
          if (assetInfo) this.store.removeAsset(rel);
          continue;
        }
        if (assetInfo && stat.size <= this.config.maxFileBytes) {
          try {
            this.indexAsset(rel, abs, assetInfo);
          } catch (err) {
            if (p.errors.length < 50) {
              p.errors.push({ path: rel, message: err instanceof Error ? err.message : String(err) });
            }
          }
        }
        const lang = languageForPath(rel);
        if (!lang || stat.size > this.config.maxFileBytes) continue;
        try {
          await this.indexOne(rel, abs, lang.id, stat.size, stat.mtimeMs, batch);
        } catch (err) {
          if (p.errors.length < 50) {
            p.errors.push({ path: rel, message: err instanceof Error ? err.message : String(err) });
          }
        }
      }
      await this.resolveBatch(batch);
      p.state = 'ready';
      if (batch.changedFileIds.length > 0 || batch.removed > 0) {
        p.totalFiles = this.store.listFiles().length;
        p.finishedAt = Date.now();
      }
    } catch (err) {
      p.state = prevState === 'error' ? 'error' : 'ready';
      p.errors.push({ path: '', message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Run resolution when the batch touched anything (or nothing is resolved yet). */
  private async resolveBatch(batch: Batch): Promise<void> {
    const dirty = batch.changedFileIds.length > 0 || batch.removed > 0;
    if (!dirty && batch.warm && !batch.staleResolve) return;

    let scope: Set<number> | undefined;
    if (batch.warm && dirty && !batch.staleResolve) {
      scope =
        affectedFilesFor(this.store, {
          changedFileIds: batch.changedFileIds,
          importersOfRemoved: batch.importersOfRemoved,
          oldSymbolNames: batch.oldSymbolNames,
        }) ?? undefined;
    }
    this.progress.resolve = await resolveWorkspace(this.store, this.config.root, scope);
  }

  /** Hash-checked (re)index of one engine asset file. */
  private indexAsset(relPath: string, absPath: string, info: AssetInfo): void {
    const source = readFileSync(absPath, 'utf8');
    const hash = createHash('sha1').update(source).digest('hex');
    if (this.store.getAssetByPath(relPath)?.hash === hash) return;
    const refs = extractAssetRefs(info, relPath, source);
    this.store.replaceAsset({ path: relPath, kind: info.kind, engine: info.engine, hash }, refs);
  }

  private removeOne(relPath: string, fileId: number, batch: Batch): void {
    if (batch.warm) {
      for (const n of this.store.symbolNamesInFiles([fileId])) batch.oldSymbolNames.add(n);
      for (const f of this.store.filesImporting([fileId])) batch.importersOfRemoved.add(f);
    }
    this.store.removeFile(relPath);
    batch.removed++;
    this.progress.removedFiles++;
  }

  private async indexOne(
    relPath: string,
    absPath: string,
    lang: LanguageId,
    size: number,
    mtimeMs: number,
    batch: Batch,
  ): Promise<void> {
    const extractor = extractorFor(lang);
    if (!extractor) return;

    const source = readFileSync(absPath, 'utf8');
    const hash = createHash('sha1').update(source).digest('hex');
    const existing = this.store.getFileByPath(relPath);
    if (existing && existing.hash === hash) return;

    if (existing && batch.warm) {
      for (const n of this.store.symbolNamesInFiles([existing.id])) batch.oldSymbolNames.add(n);
    }
    const extraction = await extractFile(extractor, source);
    const chunks = this.config.embeddings.enabled ? buildChunks(extraction, source, relPath) : [];
    const framework = frameworkForFile(lang, relPath, extraction.imports);
    let routes = framework ? await extractRoutes(framework, lang, source) : [];
    if (!framework) {
      const app = this.fileRoutes.frameworkFor(relPath);
      if (app) routes = extractFileRoutes(app, relPath, extraction);
    }
    const fileId = this.store.replaceFile(
      { path: relPath, lang, hash, size, mtimeMs, isTest: isTestPath(relPath, lang) },
      extraction,
      chunks,
      routes,
    );
    batch.changedFileIds.push(fileId);
    this.progress.changedFiles++;
  }
}
