import DatabaseCtor, { type Database } from 'better-sqlite3';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { prepareSchema, rebuildSchema } from './schema.js';
import type { ExtractedChunk } from '../embeddings/chunker.js';
import type {
  EdgeKind,
  EdgeProvenance,
  ExtractedRoute,
  FileExtraction,
  FrameworkId,
  LanguageId,
  OccurrenceRole,
  RouteRow,
  SymbolBase,
  SymbolKind,
  SymbolRow,
} from '../types.js';

export interface FileRecord {
  id: number;
  path: string;
  lang: LanguageId;
  hash: string;
  /** Path-classified test file (SQLite 0/1, truthy in JS). */
  isTest: boolean;
}

export interface SymbolSearchOptions {
  kind?: SymbolKind;
  lang?: LanguageId;
  pathPrefix?: string;
  exportedOnly?: boolean;
  limit: number;
  offset: number;
}

const SYMBOL_SELECT = `
  SELECT s.id, s.file_id AS fileId, f.path, f.lang, s.name, s.qualified_name AS qualifiedName,
         s.kind, s.start_line AS startLine, s.start_col AS startCol,
         s.end_line AS endLine, s.end_col AS endCol,
         s.signature, s.doc_comment AS docComment,
         s.parent_symbol_id AS parentSymbolId, s.is_exported AS isExported
  FROM symbols s JOIN files f ON f.id = s.file_id`;

export class Store {
  readonly db: Database;
  /** sqlite-vec loaded — cosine scans run in C instead of JS. */
  readonly vecAccel: boolean;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      mkdirSync(dir, { recursive: true });
      // keep the whole state dir out of the user's VCS
      writeFileSync(join(dir, '.gitignore'), '*\n');
    }
    this.db = new DatabaseCtor(dbPath);
    if (prepareSchema(this.db) === 'rebuild') {
      if (dbPath === ':memory:') {
        rebuildSchema(this.db);
      } else {
        // deleting the file is instant; DROP TABLE on a big index is minutes
        this.db.close();
        for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
        this.db = new DatabaseCtor(dbPath);
        prepareSchema(this.db);
      }
    }
    let vec = false;
    try {
      sqliteVec.load(this.db);
      vec = true;
    } catch {
      // unsupported platform — knnChunks falls back to a JS scan
    }
    this.vecAccel = vec;
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  getFileByPath(path: string): FileRecord | undefined {
    return this.db
      .prepare(`SELECT id, path, lang, hash, is_test AS isTest FROM files WHERE path = ?`)
      .get(path) as FileRecord | undefined;
  }

  listFiles(): FileRecord[] {
    return this.db
      .prepare(`SELECT id, path, lang, hash, is_test AS isTest FROM files`)
      .all() as FileRecord[];
  }

  /**
   * Transactionally replace all index rows for one file.
   * Deletes child rows explicitly (does not rely on FK cascades firing FTS triggers).
   */
  replaceFile(
    meta: {
      path: string;
      lang: LanguageId;
      hash: string;
      size: number;
      mtimeMs: number;
      isTest: boolean;
    },
    extraction: FileExtraction,
    chunks: ExtractedChunk[] = [],
    routes: ExtractedRoute[] = [],
  ): number {
    const txn = this.db.transaction(() => {
      // mark the graph stale in the same transaction; only a completed
      // resolution pass clears it (crash recovery for the sweep that follows)
      this.setMeta('resolve_dirty', '1');
      const existing = this.getFileByPath(meta.path);
      // vectors of the outgoing chunks, keyed by text hash: an edit that
      // leaves a symbol's text untouched must not cost a re-embedding
      const oldVectors = new Map<string, Buffer>();
      if (existing && chunks.length > 0) {
        const rows = this.db
          .prepare(
            `SELECT c.text_hash AS hash, v.embedding FROM chunks c
             JOIN chunk_vectors v ON v.chunk_id = c.id WHERE c.file_id = ?`,
          )
          .all(existing.id) as Array<{ hash: string; embedding: Buffer }>;
        for (const r of rows) if (!oldVectors.has(r.hash)) oldVectors.set(r.hash, r.embedding);
      }
      if (existing) this.deleteFileRows(existing.id);

      const fileId = existing
        ? (this.db
            .prepare(
              `UPDATE files SET lang=?, hash=?, size=?, mtime_ms=?, indexed_at=?, is_test=? WHERE id=? RETURNING id`,
            )
            .get(meta.lang, meta.hash, meta.size, meta.mtimeMs, Date.now(), meta.isTest ? 1 : 0, existing.id) as { id: number }).id
        : (this.db
            .prepare(
              `INSERT INTO files (path, lang, hash, size, mtime_ms, indexed_at, is_test) VALUES (?,?,?,?,?,?,?) RETURNING id`,
            )
            .get(meta.path, meta.lang, meta.hash, meta.size, meta.mtimeMs, Date.now(), meta.isTest ? 1 : 0) as { id: number }).id;

      const insertSymbol = this.db.prepare(`
        INSERT INTO symbols (file_id, name, qualified_name, kind, start_line, start_col,
                             end_line, end_col, signature, doc_comment, parent_symbol_id, is_exported, bases)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

      // two passes: insert with null parents, then wire parent ids
      const ids: number[] = [];
      const qualifiedNames = computeQualifiedNames(extraction);
      extraction.symbols.forEach((sym, i) => {
        const info = insertSymbol.run(
          fileId,
          sym.name,
          qualifiedNames[i]!,
          sym.kind,
          sym.startLine,
          sym.startCol,
          sym.endLine,
          sym.endCol,
          sym.signature,
          sym.docComment,
          null,
          sym.isExported ? 1 : 0,
          sym.bases.length > 0 ? JSON.stringify(sym.bases) : null,
        );
        ids.push(Number(info.lastInsertRowid));
      });
      const setParent = this.db.prepare(`UPDATE symbols SET parent_symbol_id=? WHERE id=?`);
      extraction.symbols.forEach((sym, i) => {
        if (sym.parentIndex !== null) setParent.run(ids[sym.parentIndex], ids[i]);
      });

      const insertImport = this.db.prepare(
        `INSERT INTO imports (file_id, specifier, names, start_line) VALUES (?,?,?,?)`,
      );
      for (const imp of extraction.imports) {
        insertImport.run(fileId, imp.specifier, JSON.stringify(imp.names), imp.startLine);
      }

      const insertOccurrence = this.db.prepare(`
        INSERT INTO occurrences (file_id, name, role, start_line, start_col, end_line, end_col)
        VALUES (?,?,?,?,?,?,?)`);
      for (const occ of extraction.occurrences) {
        insertOccurrence.run(
          fileId,
          occ.name,
          occ.role,
          occ.startLine,
          occ.startCol,
          occ.endLine,
          occ.endCol,
        );
      }

      const insertChunk = this.db.prepare(
        `INSERT INTO chunks (file_id, symbol_id, text_hash, content, embedded) VALUES (?,?,?,?,?)`,
      );
      const insertVector = this.db.prepare(
        `INSERT INTO chunk_vectors (chunk_id, embedding) VALUES (?, ?)`,
      );
      for (const ch of chunks) {
        const symbolId = ids[ch.symbolIndex];
        if (symbolId === undefined) continue;
        const reused = oldVectors.get(ch.textHash);
        const chunkId = insertChunk.run(fileId, symbolId, ch.textHash, ch.content, reused ? 1 : 0)
          .lastInsertRowid;
        if (reused) insertVector.run(chunkId, reused);
      }

      if (routes.length > 0) {
        const insertRoute = this.db.prepare(`
          INSERT INTO routes (file_id, framework, method, path, full_path,
                              handler_symbol_id, handler_name, start_line, detail)
          VALUES (?,?,?,?,?,?,?,?,?)`);
        for (const route of routes) {
          // positional handler: innermost callable extraction symbol on that line
          let handlerId: number | null = null;
          if (route.handlerLine !== null) {
            let bestSpan = Number.MAX_SAFE_INTEGER;
            extraction.symbols.forEach((sym, i) => {
              if (sym.startLine > route.handlerLine! || sym.endLine < route.handlerLine!) return;
              if (sym.kind !== 'function' && sym.kind !== 'method' && sym.kind !== 'constructor') return;
              const span = sym.endLine - sym.startLine;
              if (span < bestSpan) {
                bestSpan = span;
                handlerId = ids[i] ?? null;
              }
            });
          }
          insertRoute.run(
            fileId,
            route.framework,
            route.method,
            route.path,
            route.fullPath,
            handlerId,
            route.handlerName,
            route.startLine,
            route.detail,
          );
        }
      }
      return fileId;
    });
    return txn();
  }

  removeFile(path: string): void {
    const existing = this.getFileByPath(path);
    if (!existing) return;
    const txn = this.db.transaction(() => {
      this.setMeta('resolve_dirty', '1');
      this.deleteFileRows(existing.id);
      this.db.prepare(`DELETE FROM files WHERE id=?`).run(existing.id);
    });
    txn();
  }

  private deleteFileRows(fileId: number): void {
    this.db
      .prepare(
        `DELETE FROM edges WHERE src_symbol_id IN (SELECT id FROM symbols WHERE file_id=?)
                            OR dst_symbol_id IN (SELECT id FROM symbols WHERE file_id=?)`,
      )
      .run(fileId, fileId);
    this.db.prepare(`DELETE FROM routes WHERE file_id=?`).run(fileId);
    this.db.prepare(`DELETE FROM occurrences WHERE file_id=?`).run(fileId);
    this.db.prepare(`DELETE FROM imports WHERE file_id=?`).run(fileId);
    // fires the FTS delete trigger per row
    this.db.prepare(`DELETE FROM symbols WHERE file_id=?`).run(fileId);
  }

  /**
   * FTS-backed symbol search with prefix matching, falling back to substring
   * LIKE when FTS syntax rejects the query or finds nothing.
   */
  searchSymbols(query: string, opts: SymbolSearchOptions): SymbolRow[] {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (opts.kind) {
      filters.push(`s.kind = ?`);
      params.push(opts.kind);
    }
    if (opts.lang) {
      filters.push(`f.lang = ?`);
      params.push(opts.lang);
    }
    if (opts.pathPrefix) {
      filters.push(`f.path LIKE ?`);
      params.push(`${opts.pathPrefix.replace(/\\/g, '/')}%`);
    }
    if (opts.exportedOnly) filters.push(`s.is_exported = 1`);
    const filterSql = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const ftsQuery = toFtsQuery(query);
    if (ftsQuery) {
      try {
        const rows = this.db
          .prepare(
            `${SYMBOL_SELECT}
             JOIN symbols_fts ON symbols_fts.rowid = s.id
             WHERE symbols_fts MATCH ? ${filterSql}
             ORDER BY bm25(symbols_fts, 10.0, 5.0, 1.0), length(s.name)
             LIMIT ? OFFSET ?`,
          )
          .all(ftsQuery, ...params, opts.limit, opts.offset) as unknown as SymbolRow[];
        if (rows.length > 0) return normalize(rows);
      } catch {
        // fall through to LIKE on FTS syntax errors
      }
    }

    const rows = this.db
      .prepare(
        `${SYMBOL_SELECT}
         WHERE s.name LIKE ? ESCAPE '\\' ${filterSql}
         ORDER BY length(s.name), s.name
         LIMIT ? OFFSET ?`,
      )
      .all(`%${escapeLike(query)}%`, ...params, opts.limit, opts.offset) as unknown as SymbolRow[];
    return normalize(rows);
  }

  /** Exact name or qualified-name matches — index lookup, no FTS ranking. */
  symbolsByExactName(name: string, limit = 10): SymbolRow[] {
    const rows = this.db
      .prepare(
        `${SYMBOL_SELECT} WHERE s.name = ? OR s.qualified_name = ?
         ORDER BY s.is_exported DESC, f.path, s.start_line LIMIT ?`,
      )
      .all(name, name, limit) as unknown as SymbolRow[];
    const matches = normalize(rows);
    // Constructors (Java/C#) and impl blocks (Rust) share their type's name;
    // when everything else is one of those, the type is the unambiguous answer.
    const types = matches.filter((m) =>
      ['class', 'interface', 'struct', 'enum', 'trait'].includes(m.kind),
    );
    if (types.length === 1) {
      const type = types[0]!;
      const rest = matches.filter((m) => m !== type);
      if (
        rest.every(
          (m) =>
            (m.kind === 'constructor' && m.parentSymbolId === type.id) ||
            (m.kind === 'impl' && m.path === type.path),
        )
      ) {
        return [type];
      }
    }
    return matches;
  }

  symbolsForFile(fileId: number): SymbolRow[] {
    const rows = this.db
      .prepare(`${SYMBOL_SELECT} WHERE s.file_id = ? ORDER BY s.start_line, s.start_col`)
      .all(fileId) as unknown as SymbolRow[];
    return normalize(rows);
  }

  getSymbolById(id: number): SymbolRow | undefined {
    const row = this.db.prepare(`${SYMBOL_SELECT} WHERE s.id = ?`).get(id) as
      | SymbolRow
      | undefined;
    return row ? normalize([row])[0] : undefined;
  }

  /** Innermost symbol whose range contains the given position. */
  symbolAt(fileId: number, line: number, col: number): SymbolRow | undefined {
    const row = this.db
      .prepare(
        `${SYMBOL_SELECT}
         WHERE s.file_id = ?
           AND (s.start_line < ? OR (s.start_line = ? AND s.start_col <= ?))
           AND (s.end_line > ? OR (s.end_line = ? AND s.end_col >= ?))
         ORDER BY (s.end_line - s.start_line) ASC, s.start_line DESC
         LIMIT 1`,
      )
      .get(fileId, line, line, col, line, line, col) as SymbolRow | undefined;
    return row ? normalize([row])[0] : undefined;
  }

  // ---------- resolution pass (bulk, called by the resolver) ----------

  listImportRows(): ImportRow[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.file_id AS fileId, f.path, f.lang, i.specifier, i.names, i.resolved_file_id AS resolvedFileId
         FROM imports i JOIN files f ON f.id = i.file_id`,
      )
      .all() as Array<Omit<ImportRow, 'names'> & { names: string }>;
    return rows.map((r) => ({ ...r, names: JSON.parse(r.names) as string[] }));
  }

  applyImportResolutions(resolutions: Array<{ id: number; fileId: number | null }>): void {
    const stmt = this.db.prepare(`UPDATE imports SET resolved_file_id = ? WHERE id = ?`);
    const txn = this.db.transaction(() => {
      for (const r of resolutions) stmt.run(r.fileId, r.id);
    });
    txn();
  }

  listSymbolsLite(): SymbolLite[] {
    const rows = this.db
      .prepare(
        `SELECT id, file_id AS fileId, name, kind, parent_symbol_id AS parentSymbolId,
                is_exported AS isExported, start_line AS startLine, start_col AS startCol,
                end_line AS endLine, end_col AS endCol, bases
         FROM symbols`,
      )
      .all() as Array<Omit<SymbolLite, 'bases' | 'isExported'> & { bases: string | null; isExported: number }>;
    return rows.map((r) => ({
      ...r,
      isExported: Boolean(r.isExported),
      bases: r.bases ? (JSON.parse(r.bases) as SymbolBase[]) : [],
    }));
  }

  listOccurrenceRows(): OccurrenceRow[] {
    return this.db
      .prepare(
        `SELECT id, file_id AS fileId, name, role, start_line AS startLine, start_col AS startCol
         FROM occurrences`,
      )
      .all() as OccurrenceRow[];
  }

  /**
   * The identifier occurrence at (or nearest on) a line; with a column, the
   * occurrence spanning it wins, else the closest start on that line.
   */
  occurrenceAt(
    fileId: number,
    line: number,
    col: number | null,
  ): { name: string; startCol: number; resolvedSymbolId: number | null; confidence: number | null } | undefined {
    const rows = this.db
      .prepare(
        `SELECT name, start_col AS startCol, end_col AS endCol,
                resolved_symbol_id AS resolvedSymbolId, confidence
         FROM occurrences WHERE file_id = ? AND start_line = ? ORDER BY start_col`,
      )
      .all(fileId, line) as Array<{
      name: string; startCol: number; endCol: number;
      resolvedSymbolId: number | null; confidence: number | null;
    }>;
    if (rows.length === 0) return undefined;
    if (col === null) return rows[0];
    return (
      rows.find((r) => r.startCol <= col && col <= r.endCol) ??
      rows.reduce((a, b) => (Math.abs(a.startCol - col) <= Math.abs(b.startCol - col) ? a : b))
    );
  }

  listOccurrenceRowsForFiles(fileIds: Iterable<number>): OccurrenceRow[] {
    const out: OccurrenceRow[] = [];
    const stmt = this.db.prepare(
      `SELECT id, file_id AS fileId, name, role, start_line AS startLine, start_col AS startCol
       FROM occurrences WHERE file_id = ?`,
    );
    for (const id of fileIds) out.push(...(stmt.all(id) as OccurrenceRow[]));
    return out;
  }

  /** Distinct symbol names defined in the given files. */
  symbolNamesInFiles(fileIds: Iterable<number>): Set<string> {
    const out = new Set<string>();
    const stmt = this.db.prepare(`SELECT DISTINCT name FROM symbols WHERE file_id = ?`);
    for (const id of fileIds) {
      for (const row of stmt.all(id) as Array<{ name: string }>) out.add(row.name);
    }
    return out;
  }

  /** Files whose imports resolve into any of the given files. */
  filesImporting(fileIds: Iterable<number>): Set<number> {
    const out = new Set<number>();
    const stmt = this.db.prepare(
      `SELECT DISTINCT file_id AS fileId FROM imports WHERE resolved_file_id = ?`,
    );
    for (const id of fileIds) {
      for (const row of stmt.all(id) as Array<{ fileId: number }>) out.add(row.fileId);
    }
    return out;
  }

  /** Files containing at least one occurrence of any of the given names. */
  filesWithOccurrenceNames(names: Iterable<string>): Set<number> {
    const out = new Set<number>();
    const stmt = this.db.prepare(
      `SELECT DISTINCT file_id AS fileId FROM occurrences WHERE name = ?`,
    );
    for (const name of names) {
      for (const row of stmt.all(name) as Array<{ fileId: number }>) out.add(row.fileId);
    }
    return out;
  }

  clearResolutionsForFiles(fileIds: Iterable<number>): void {
    const stmt = this.db.prepare(
      `UPDATE occurrences SET resolved_symbol_id = NULL, confidence = NULL WHERE file_id = ?`,
    );
    const txn = this.db.transaction(() => {
      for (const id of fileIds) stmt.run(id);
    });
    txn();
  }

  /** Delete index-provenance edges whose source symbol lives in the given files. */
  clearIndexEdgesFromFiles(fileIds: Iterable<number>): void {
    const stmt = this.db.prepare(
      `DELETE FROM edges WHERE provenance = 'index'
         AND src_symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)`,
    );
    const txn = this.db.transaction(() => {
      for (const id of fileIds) stmt.run(id);
    });
    txn();
  }

  applyOccurrenceResolutions(
    resolutions: Array<{ id: number; symbolId: number; confidence: number }>,
  ): void {
    const stmt = this.db.prepare(
      `UPDATE occurrences SET resolved_symbol_id = ?, confidence = ? WHERE id = ?`,
    );
    const txn = this.db.transaction(() => {
      for (const r of resolutions) stmt.run(r.symbolId, r.confidence, r.id);
    });
    txn();
  }

  /**
   * Commit one resolution pass atomically: clear the stale resolutions/edges
   * (scoped or all-index) and write the new ones in a single transaction, so
   * a crash mid-pass can never leave the graph half-cleared.
   */
  applyResolutionPass(
    scope: Iterable<number> | null,
    occResolutions: Array<{ id: number; symbolId: number; confidence: number }>,
    edges: EdgeInsert[],
  ): void {
    const scopeIds = scope ? [...scope] : null;
    const txn = this.db.transaction(() => {
      if (scopeIds) {
        this.clearResolutionsForFiles(scopeIds);
        this.clearIndexEdgesFromFiles(scopeIds);
      } else {
        this.clearEdges('index');
      }
      this.applyOccurrenceResolutions(occResolutions);
      this.insertEdges(edges);
      this.setMeta('resolve_dirty', '0');
    });
    txn();
  }

  /** Drop all edges of one provenance (before a fresh resolution pass). */
  clearEdges(provenance: EdgeProvenance): void {
    this.db.prepare(`DELETE FROM edges WHERE provenance = ?`).run(provenance);
  }

  insertEdges(edges: EdgeInsert[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO edges (src_symbol_id, dst_symbol_id, kind, confidence, provenance)
       VALUES (?,?,?,?,?)
       ON CONFLICT(src_symbol_id, dst_symbol_id, kind)
       DO UPDATE SET
         provenance = CASE WHEN excluded.confidence >= confidence THEN excluded.provenance ELSE provenance END,
         confidence = MAX(confidence, excluded.confidence)`,
    );
    const txn = this.db.transaction(() => {
      for (const e of edges) stmt.run(e.srcSymbolId, e.dstSymbolId, e.kind, e.confidence, e.provenance);
    });
    txn();
  }

  // ---------- graph queries (tools) ----------

  /**
   * References to a symbol: occurrences resolved to it, plus unresolved
   * same-name occurrences as low-confidence candidates.
   */
  referencesTo(symbolId: number, name: string, limit: number, offset: number): ReferenceRow[] {
    return this.db
      .prepare(
        `SELECT o.id, f.path, o.name, o.role, o.start_line AS startLine, o.start_col AS startCol,
                o.resolved_symbol_id AS resolvedSymbolId, o.confidence
         FROM occurrences o JOIN files f ON f.id = o.file_id
         WHERE o.resolved_symbol_id = ? OR (o.resolved_symbol_id IS NULL AND o.name = ?)
         ORDER BY (o.resolved_symbol_id IS NULL), f.path, o.start_line
         LIMIT ? OFFSET ?`,
      )
      .all(symbolId, name, limit, offset) as ReferenceRow[];
  }

  /**
   * Symbols with zero incoming references anywhere: no occurrence resolves to
   * them and no edge targets them (both columns indexed). Raw candidates —
   * the health tool layers entry-point/route/lifecycle exclusions on top.
   */
  deadCandidates(opts: {
    kinds: string[];
    lang?: LanguageId;
    pathPrefix?: string;
    limit: number;
  }): SymbolRow[] {
    const conds: string[] = [
      `s.kind IN (${opts.kinds.map(() => '?').join(',')})`,
      `NOT EXISTS (SELECT 1 FROM occurrences o WHERE o.resolved_symbol_id = s.id)`,
      `NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst_symbol_id = s.id)`,
      // local closures and factory-object members live and die with their
      // enclosing function — reporting them as dead is pure noise
      `NOT EXISTS (SELECT 1 FROM symbols p WHERE p.id = s.parent_symbol_id
                   AND p.kind IN ('function','method','constructor'))`,
    ];
    const params: unknown[] = [...opts.kinds];
    if (opts.lang) {
      conds.push(`f.lang = ?`);
      params.push(opts.lang);
    }
    if (opts.pathPrefix) {
      conds.push(`f.path LIKE ? ESCAPE '\\'`);
      params.push(`${escapeLike(opts.pathPrefix)}%`);
    }
    params.push(opts.limit);
    const rows = this.db
      .prepare(`${SYMBOL_SELECT} WHERE ${conds.join(' AND ')} ORDER BY f.path, s.start_line LIMIT ?`)
      .all(...params) as unknown as SymbolRow[];
    return normalize(rows);
  }

  /** Exported symbols referenced only from their own file — the export is unused. */
  internalOnlyExports(opts: {
    kinds: string[];
    lang?: LanguageId;
    pathPrefix?: string;
    limit: number;
  }): SymbolRow[] {
    const conds: string[] = [
      `s.is_exported = 1`,
      `s.parent_symbol_id IS NULL`,
      `s.kind IN (${opts.kinds.map(() => '?').join(',')})`,
      `NOT EXISTS (SELECT 1 FROM occurrences o WHERE o.resolved_symbol_id = s.id AND o.file_id != s.file_id)`,
      `NOT EXISTS (SELECT 1 FROM edges e JOIN symbols src ON src.id = e.src_symbol_id
                   WHERE e.dst_symbol_id = s.id AND src.file_id != s.file_id)`,
      // has at least one internal use, else it belongs in the dead list instead
      `(EXISTS (SELECT 1 FROM occurrences o WHERE o.resolved_symbol_id = s.id)
        OR EXISTS (SELECT 1 FROM edges e WHERE e.dst_symbol_id = s.id))`,
    ];
    const params: unknown[] = [...opts.kinds];
    if (opts.lang) {
      conds.push(`f.lang = ?`);
      params.push(opts.lang);
    }
    if (opts.pathPrefix) {
      conds.push(`f.path LIKE ? ESCAPE '\\'`);
      params.push(`${escapeLike(opts.pathPrefix)}%`);
    }
    params.push(opts.limit);
    const rows = this.db
      .prepare(`${SYMBOL_SELECT} WHERE ${conds.join(' AND ')} ORDER BY f.path, s.start_line LIMIT ?`)
      .all(...params) as unknown as SymbolRow[];
    return normalize(rows);
  }

  /**
   * Occurrence counts per name — dynamic-dispatch hedging for dead-code claims.
   * unresolvedOnly counts only unbound usages; false counts every usage (methods:
   * a same-name call resolved to a *different* symbol is exactly the dispatch
   * ambiguity the hedge exists for).
   */
  nameOccurrenceCounts(names: Iterable<string>, unresolvedOnly: boolean): Map<string, number> {
    const out = new Map<string, number>();
    const stmt = this.db.prepare(
      `SELECT COUNT(*) AS n FROM occurrences WHERE name = ?${unresolvedOnly ? ' AND resolved_symbol_id IS NULL' : ''}`,
    );
    for (const name of new Set(names)) {
      const n = (stmt.get(name) as { n: number }).n;
      if (n > 0) out.set(name, n);
    }
    return out;
  }

  /** Approximate line count per file (max symbol end line) — sizes for hotspot scoring. */
  fileLineCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const row of this.db
      .prepare(`SELECT f.path, MAX(s.end_line) AS lines FROM files f JOIN symbols s ON s.file_id = f.id GROUP BY f.id`)
      .all() as Array<{ path: string; lines: number }>) {
      out.set(row.path, row.lines);
    }
    return out;
  }

  /** Symbol ids serving as route handlers, and file ids containing any route. */
  routeAnchors(): { handlerIds: Set<number>; fileIds: Set<number> } {
    const handlerIds = new Set<number>();
    const fileIds = new Set<number>();
    for (const row of this.db
      .prepare(`SELECT handler_symbol_id AS h, file_id AS f FROM routes`)
      .all() as Array<{ h: number | null; f: number }>) {
      if (row.h !== null) handlerIds.add(row.h);
      fileIds.add(row.f);
    }
    return { handlerIds, fileIds };
  }

  /**
   * Unresolved occurrences of a name outside one file — the damage sites left
   * behind when a definition of that name is removed.
   */
  unresolvedOccurrencesOfName(
    name: string,
    excludeFileId: number | null,
    limit = 20,
  ): Array<{ path: string; startLine: number; role: string }> {
    return this.db
      .prepare(
        `SELECT f.path, o.start_line AS startLine, o.role
         FROM occurrences o JOIN files f ON f.id = o.file_id
         WHERE o.name = ? AND o.resolved_symbol_id IS NULL AND o.file_id != ?
         ORDER BY f.path, o.start_line LIMIT ?`,
      )
      .all(name, excludeFileId ?? -1, limit) as Array<{ path: string; startLine: number; role: string }>;
  }

  /** Outgoing (srcSymbolId=from) or incoming (dstSymbolId=from) edges with symbol info. */
  edgesFor(symbolId: number, direction: 'out' | 'in', kinds: EdgeKind[]): EdgeRow[] {
    const joinCol = direction === 'out' ? 'e.dst_symbol_id' : 'e.src_symbol_id';
    const whereCol = direction === 'out' ? 'e.src_symbol_id' : 'e.dst_symbol_id';
    const placeholders = kinds.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT s.id AS symbolId, s.name, s.qualified_name AS qualifiedName, s.kind AS symbolKind,
                f.path, s.start_line AS startLine, e.kind AS edgeKind, e.confidence, e.provenance
         FROM edges e
         JOIN symbols s ON s.id = ${joinCol}
         JOIN files f ON f.id = s.file_id
         WHERE ${whereCol} = ? AND e.kind IN (${placeholders})
         ORDER BY e.confidence DESC, s.name`,
      )
      .all(symbolId, ...kinds) as EdgeRow[];
  }

  /** Files this file imports (resolved), plus unresolved/external specifiers. */
  dependenciesOf(fileId: number): DependencyRow[] {
    return this.db
      .prepare(
        `SELECT i.specifier, i.start_line AS startLine, f.path AS resolvedPath
         FROM imports i LEFT JOIN files f ON f.id = i.resolved_file_id
         WHERE i.file_id = ?
         ORDER BY i.start_line`,
      )
      .all(fileId) as DependencyRow[];
  }

  /** Files that import this file. */
  dependentsOf(fileId: number): Array<{ path: string; specifier: string; startLine: number }> {
    return this.db
      .prepare(
        `SELECT f.path, i.specifier, i.start_line AS startLine
         FROM imports i JOIN files f ON f.id = i.file_id
         WHERE i.resolved_file_id = ?
         ORDER BY f.path, i.start_line`,
      )
      .all(fileId) as Array<{ path: string; specifier: string; startLine: number }>;
  }

  /** Every workspace-internal import pair (src imports dst), deduplicated. */
  importPairs(): Array<{ src: string; dst: string }> {
    return this.db
      .prepare(
        `SELECT DISTINCT fs.path AS src, fd.path AS dst
         FROM imports i
         JOIN files fs ON fs.id = i.file_id
         JOIN files fd ON fd.id = i.resolved_file_id
         ORDER BY src, dst`,
      )
      .all() as Array<{ src: string; dst: string }>;
  }

  countsByLanguage(): Array<{ lang: LanguageId; files: number; symbols: number }> {
    return this.db
      .prepare(
        `SELECT f.lang, COUNT(DISTINCT f.id) AS files, COUNT(s.id) AS symbols
         FROM files f LEFT JOIN symbols s ON s.file_id = f.id
         GROUP BY f.lang ORDER BY files DESC`,
      )
      .all() as Array<{ lang: LanguageId; files: number; symbols: number }>;
  }

  stats(): { files: number; symbols: number; imports: number; occurrences: number; edges: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      files: one(`SELECT COUNT(*) AS n FROM files`),
      symbols: one(`SELECT COUNT(*) AS n FROM symbols`),
      imports: one(`SELECT COUNT(*) AS n FROM imports`),
      occurrences: one(`SELECT COUNT(*) AS n FROM occurrences`),
      edges: one(`SELECT COUNT(*) AS n FROM edges`),
    };
  }

  // ---------- embeddings ----------

  embeddingStats(): { chunks: number; embedded: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      chunks: one(`SELECT COUNT(*) AS n FROM chunks`),
      embedded: one(`SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1`),
    };
  }

  /** Chunks awaiting a vector, oldest files first. */
  pendingChunks(limit: number): Array<{ id: number; content: string }> {
    return this.db
      .prepare(`SELECT id, content FROM chunks WHERE embedded = 0 LIMIT ?`)
      .all(limit) as Array<{ id: number; content: string }>;
  }

  writeChunkVectors(rows: Array<{ chunkId: number; vector: Float32Array }>): void {
    const insert = this.db.prepare(
      `INSERT INTO chunk_vectors (chunk_id, embedding) VALUES (?, ?)
       ON CONFLICT(chunk_id) DO UPDATE SET embedding = excluded.embedding`,
    );
    const mark = this.db.prepare(`UPDATE chunks SET embedded = 1 WHERE id = ?`);
    const txn = this.db.transaction(() => {
      for (const r of rows) {
        insert.run(r.chunkId, Buffer.from(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength));
        mark.run(r.chunkId);
      }
    });
    txn();
  }

  /** Stored vector for a symbol (its first embedded chunk), or null. */
  vectorForSymbol(symbolId: number): Float32Array | null {
    const row = this.db
      .prepare(
        `SELECT v.embedding FROM chunks c JOIN chunk_vectors v ON v.chunk_id = c.id
         WHERE c.symbol_id = ? ORDER BY c.id LIMIT 1`,
      )
      .get(symbolId) as { embedding: Buffer } | undefined;
    if (!row) return null;
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  }

  /** First chunk content for a symbol — the text its vector would embed. */
  chunkContentForSymbol(symbolId: number): string | null {
    const row = this.db
      .prepare(`SELECT content FROM chunks WHERE symbol_id = ? ORDER BY id LIMIT 1`)
      .get(symbolId) as { content: string } | undefined;
    return row?.content ?? null;
  }

  /** Every chunk's content (for the shingle-similarity fallback). Caller caps workload. */
  allChunks(lang?: LanguageId): Array<{ id: number; symbolId: number; content: string }> {
    const join = lang ? `JOIN files f ON f.id = c.file_id WHERE f.lang = ?` : '';
    return this.db
      .prepare(`SELECT c.id, c.symbol_id AS symbolId, c.content FROM chunks c ${join}`)
      .all(...(lang ? [lang] : [])) as Array<{ id: number; symbolId: number; content: string }>;
  }

  /** Drop all vectors (model change) — chunks stay and re-embed under the new model. */
  resetEmbeddings(): void {
    const txn = this.db.transaction(() => {
      this.db.exec(`DELETE FROM chunk_vectors`);
      this.db.exec(`UPDATE chunks SET embedded = 0`);
    });
    txn();
  }

  /**
   * Nearest chunks to a (normalized) query vector by cosine similarity.
   * Full scan — via sqlite-vec's C implementation when the extension loaded,
   * else a JS dot product. Both are well under 100 ms at 100k chunks.
   */
  knnChunks(
    query: Float32Array,
    k: number,
    lang?: LanguageId,
  ): Array<{ chunkId: number; symbolId: number; score: number }> {
    const langJoin = lang ? `JOIN files f ON f.id = c.file_id` : '';
    const langWhere = lang ? `WHERE f.lang = ?` : '';
    if (this.vecAccel) {
      const params: unknown[] = [Buffer.from(query.buffer, query.byteOffset, query.byteLength)];
      if (lang) params.push(lang);
      params.push(k);
      try {
        return this.db
          .prepare(
            `SELECT c.id AS chunkId, c.symbol_id AS symbolId,
                    1.0 - vec_distance_cosine(v.embedding, ?) AS score
             FROM chunk_vectors v JOIN chunks c ON c.id = v.chunk_id ${langJoin} ${langWhere}
             ORDER BY score DESC LIMIT ?`,
          )
          .all(...params) as Array<{ chunkId: number; symbolId: number; score: number }>;
      } catch {
        // dimension mismatch mid-model-change etc. — fall through to the JS scan
      }
    }
    const stmt = this.db.prepare(
      `SELECT c.id AS chunkId, c.symbol_id AS symbolId, v.embedding
       FROM chunk_vectors v JOIN chunks c ON c.id = v.chunk_id ${langJoin} ${langWhere}`,
    );
    const rows = (lang ? stmt.all(lang) : stmt.all()) as Array<{
      chunkId: number;
      symbolId: number;
      embedding: Buffer;
    }>;
    const top: Array<{ chunkId: number; symbolId: number; score: number }> = [];
    for (const r of rows) {
      const dims = r.embedding.byteLength / 4;
      if (dims !== query.length) continue;
      const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, dims);
      let dot = 0;
      for (let i = 0; i < dims; i++) dot += v[i]! * query[i]!;
      if (top.length < k) {
        top.push({ chunkId: r.chunkId, symbolId: r.symbolId, score: dot });
        if (top.length === k) top.sort((a, b) => a.score - b.score);
      } else if (dot > top[0]!.score) {
        top[0] = { chunkId: r.chunkId, symbolId: r.symbolId, score: dot };
        top.sort((a, b) => a.score - b.score);
      }
    }
    return top.sort((a, b) => b.score - a.score);
  }

  // ---------- engine assets ----------

  getAssetByPath(path: string): AssetRecord | undefined {
    return this.db
      .prepare(`SELECT id, path, kind, engine, hash FROM assets WHERE path = ?`)
      .get(path) as AssetRecord | undefined;
  }

  listAssets(): AssetRecord[] {
    return this.db
      .prepare(`SELECT id, path, kind, engine, hash FROM assets`)
      .all() as AssetRecord[];
  }

  replaceAsset(
    meta: { path: string; kind: string; engine: string; hash: string },
    refs: AssetRefInsert[],
  ): void {
    const txn = this.db.transaction(() => {
      const existing = this.getAssetByPath(meta.path);
      if (existing) this.db.prepare(`DELETE FROM assets WHERE id = ?`).run(existing.id);
      const assetId = this.db
        .prepare(
          `INSERT INTO assets (path, kind, engine, hash, indexed_at) VALUES (?,?,?,?,?) RETURNING id`,
        )
        .get(meta.path, meta.kind, meta.engine, meta.hash, Date.now()) as { id: number };
      const insert = this.db.prepare(
        `INSERT INTO asset_refs (asset_id, target_kind, target, detail) VALUES (?,?,?,?)`,
      );
      for (const r of refs) insert.run(assetId.id, r.targetKind, r.target, r.detail);
    });
    txn();
  }

  removeAsset(path: string): void {
    this.db.prepare(`DELETE FROM assets WHERE path = ?`).run(path);
  }

  refsForAsset(assetId: number): AssetRefRow[] {
    return this.db
      .prepare(
        `SELECT target_kind AS targetKind, target, detail FROM asset_refs WHERE asset_id = ? ORDER BY id`,
      )
      .all(assetId) as AssetRefRow[];
  }

  /** Assets holding a ref to any of the given targets (exact match). */
  assetsReferencing(targets: string[]): Array<AssetRecord & AssetRefRow> {
    if (targets.length === 0) return [];
    const placeholders = targets.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT a.id, a.path, a.kind, a.engine, a.hash,
                r.target_kind AS targetKind, r.target, r.detail
         FROM asset_refs r JOIN assets a ON a.id = r.asset_id
         WHERE r.target IN (${placeholders})
         ORDER BY a.path, r.id`,
      )
      .all(...targets) as Array<AssetRecord & AssetRefRow>;
  }

  assetStats(): Array<{ engine: string; kind: string; n: number }> {
    return this.db
      .prepare(`SELECT engine, kind, COUNT(*) AS n FROM assets GROUP BY engine, kind ORDER BY engine, kind`)
      .all() as Array<{ engine: string; kind: string; n: number }>;
  }

  // ---------- web-framework routes ----------

  routeStats(): Array<{ framework: FrameworkId; n: number }> {
    return this.db
      .prepare(`SELECT framework, COUNT(*) AS n FROM routes GROUP BY framework ORDER BY n DESC`)
      .all() as Array<{ framework: FrameworkId; n: number }>;
  }

  listRoutes(opts: {
    framework?: FrameworkId;
    method?: string;
    pathContains?: string;
    limit: number;
    offset: number;
  }): RouteRow[] {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (opts.framework) {
      filters.push(`r.framework = ?`);
      params.push(opts.framework);
    }
    if (opts.method) {
      filters.push(`(r.method = ? OR r.method = 'ANY')`);
      params.push(opts.method.toUpperCase());
    }
    if (opts.pathContains) {
      filters.push(`(r.path LIKE ? OR r.full_path LIKE ?)`);
      params.push(`%${opts.pathContains}%`, `%${opts.pathContains}%`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT r.id, r.framework, r.method, r.path, r.full_path AS fullPath,
                f.path AS filePath, r.start_line AS startLine,
                r.handler_symbol_id AS handlerSymbolId, r.handler_name AS handlerName, r.detail
         FROM routes r JOIN files f ON f.id = r.file_id
         ${where}
         ORDER BY COALESCE(r.full_path, r.path), r.method
         LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit, opts.offset) as RouteRow[];
  }

  /** Routes whose handler is only a name so far — the resolver fills these. */
  routesWithUnresolvedHandlers(fileIds?: Iterable<number>): Array<{
    id: number;
    fileId: number;
    handlerName: string;
  }> {
    const scope = fileIds ? [...fileIds] : null;
    if (scope && scope.length === 0) return [];
    const where = scope ? `AND r.file_id IN (${scope.map(() => '?').join(',')})` : '';
    return this.db
      .prepare(
        `SELECT r.id, r.file_id AS fileId, r.handler_name AS handlerName
         FROM routes r
         WHERE r.handler_symbol_id IS NULL AND r.handler_name IS NOT NULL ${where}`,
      )
      .all(...(scope ?? [])) as Array<{ id: number; fileId: number; handlerName: string }>;
  }

  setRouteHandler(routeId: number, symbolId: number): void {
    this.db.prepare(`UPDATE routes SET handler_symbol_id = ? WHERE id = ?`).run(symbolId, routeId);
  }

  /** Routes handled by any of the given symbols — change_impact's [ROUTE] tags. */
  routesForSymbols(symbolIds: Iterable<number>): Map<number, Array<{ method: string; path: string }>> {
    const ids = [...symbolIds];
    const out = new Map<number, Array<{ method: string; path: string }>>();
    if (ids.length === 0) return out;
    const stmt = this.db.prepare(
      `SELECT handler_symbol_id AS symbolId, method, COALESCE(full_path, path) AS path
       FROM routes WHERE handler_symbol_id = ?`,
    );
    for (const id of ids) {
      const rows = stmt.all(id) as Array<{ symbolId: number; method: string; path: string }>;
      if (rows.length > 0) out.set(id, rows.map((r) => ({ method: r.method, path: r.path })));
    }
    return out;
  }

  /** Unity: guid declared by `<path>.meta`. */
  guidForPath(path: string): string | null {
    const row = this.db
      .prepare(
        `SELECT r.target FROM asset_refs r JOIN assets a ON a.id = r.asset_id
         WHERE a.path = ? AND r.target_kind = 'guid_of'`,
      )
      .get(`${path}.meta`) as { target: string } | undefined;
    return row?.target ?? null;
  }

  /** Unity: file a guid points at (via its .meta). */
  pathForGuid(guid: string): string | null {
    const row = this.db
      .prepare(`SELECT detail FROM asset_refs WHERE target_kind = 'guid_of' AND target = ?`)
      .get(guid) as { detail: string | null } | undefined;
    return row?.detail ?? null;
  }

  /** Symbols whose declaration header contains a marker (attributes, annotations). */
  symbolsWithSignatureLike(needle: string, lang: LanguageId | undefined, limit: number): SymbolRow[] {
    const langFilter = lang ? `AND f.lang = ?` : '';
    const params: unknown[] = [`%${escapeLike(needle)}%`];
    if (lang) params.push(lang);
    params.push(limit);
    const rows = this.db
      .prepare(
        `${SYMBOL_SELECT} WHERE s.signature LIKE ? ESCAPE '\\' ${langFilter}
         ORDER BY f.path, s.start_line LIMIT ?`,
      )
      .all(...params) as unknown as SymbolRow[];
    return normalize(rows);
  }

  /** Symbols whose doc comment contains the needle (reflection metadata lives there). */
  symbolsWithDocLike(needle: string, limit: number): SymbolRow[] {
    const rows = this.db
      .prepare(
        `${SYMBOL_SELECT} WHERE s.doc_comment LIKE ? ESCAPE '\\'
         ORDER BY f.path, s.start_line LIMIT ?`,
      )
      .all(`%${escapeLike(needle)}%`, limit) as unknown as SymbolRow[];
    return normalize(rows);
  }
}

export interface ImportRow {
  id: number;
  fileId: number;
  path: string;
  lang: LanguageId;
  specifier: string;
  names: string[];
  resolvedFileId: number | null;
}

export interface SymbolLite {
  id: number;
  fileId: number;
  name: string;
  kind: SymbolKind;
  parentSymbolId: number | null;
  isExported: boolean;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  bases: SymbolBase[];
}

export interface OccurrenceRow {
  id: number;
  fileId: number;
  name: string;
  role: OccurrenceRole;
  startLine: number;
  startCol: number;
}

export interface EdgeInsert {
  srcSymbolId: number;
  dstSymbolId: number;
  kind: EdgeKind;
  confidence: number;
  provenance: EdgeProvenance;
}

export interface ReferenceRow {
  id: number;
  path: string;
  name: string;
  role: OccurrenceRole;
  startLine: number;
  startCol: number;
  resolvedSymbolId: number | null;
  confidence: number | null;
}

export interface EdgeRow {
  symbolId: number;
  name: string;
  qualifiedName: string;
  symbolKind: SymbolKind;
  path: string;
  startLine: number;
  edgeKind: EdgeKind;
  confidence: number;
  provenance: EdgeProvenance;
}

export interface DependencyRow {
  specifier: string;
  startLine: number;
  resolvedPath: string | null;
}

export interface AssetRecord {
  id: number;
  path: string;
  kind: string;
  engine: string;
  hash: string;
}

export interface AssetRefInsert {
  targetKind: string;
  target: string;
  detail: string | null;
}

export interface AssetRefRow {
  targetKind: string;
  target: string;
  detail: string | null;
}

function normalize(rows: SymbolRow[]): SymbolRow[] {
  for (const row of rows) row.isExported = Boolean(row.isExported);
  return rows;
}

/** Build an FTS5 prefix query from free text, quoting each term to disarm operators. */
function toFtsQuery(query: string): string | null {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(' ');
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** parent-chain qualified names, e.g. `ClassName.method`. */
export function computeQualifiedNames(extraction: FileExtraction): string[] {
  return extraction.symbols.map((sym) => {
    const parts = [sym.name];
    let p = sym.parentIndex;
    let guard = 0;
    while (p !== null && guard++ < 32) {
      const parent = extraction.symbols[p];
      if (!parent) break;
      parts.unshift(parent.name);
      p = parent.parentIndex;
    }
    return parts.join('.');
  });
}
