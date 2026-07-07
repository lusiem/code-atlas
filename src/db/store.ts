import DatabaseCtor, { type Database } from 'better-sqlite3';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { prepareSchema, rebuildSchema } from './schema.js';
import type {
  EdgeKind,
  EdgeProvenance,
  FileExtraction,
  LanguageId,
  OccurrenceRole,
  SymbolBase,
  SymbolKind,
  SymbolRow,
} from '../types.js';

export interface FileRecord {
  id: number;
  path: string;
  lang: LanguageId;
  hash: string;
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
      .prepare(`SELECT id, path, lang, hash FROM files WHERE path = ?`)
      .get(path) as FileRecord | undefined;
  }

  listFiles(): FileRecord[] {
    return this.db.prepare(`SELECT id, path, lang, hash FROM files`).all() as FileRecord[];
  }

  /**
   * Transactionally replace all index rows for one file.
   * Deletes child rows explicitly (does not rely on FK cascades firing FTS triggers).
   */
  replaceFile(
    meta: { path: string; lang: LanguageId; hash: string; size: number; mtimeMs: number },
    extraction: FileExtraction,
  ): number {
    const txn = this.db.transaction(() => {
      const existing = this.getFileByPath(meta.path);
      if (existing) this.deleteFileRows(existing.id);

      const fileId = existing
        ? (this.db
            .prepare(
              `UPDATE files SET lang=?, hash=?, size=?, mtime_ms=?, indexed_at=? WHERE id=? RETURNING id`,
            )
            .get(meta.lang, meta.hash, meta.size, meta.mtimeMs, Date.now(), existing.id) as { id: number }).id
        : (this.db
            .prepare(
              `INSERT INTO files (path, lang, hash, size, mtime_ms, indexed_at) VALUES (?,?,?,?,?,?) RETURNING id`,
            )
            .get(meta.path, meta.lang, meta.hash, meta.size, meta.mtimeMs, Date.now()) as { id: number }).id;

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
      return fileId;
    });
    return txn();
  }

  removeFile(path: string): void {
    const existing = this.getFileByPath(path);
    if (!existing) return;
    const txn = this.db.transaction(() => {
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

  /** Drop all edges of one provenance (before a fresh resolution pass). */
  clearEdges(provenance: EdgeProvenance): void {
    this.db.prepare(`DELETE FROM edges WHERE provenance = ?`).run(provenance);
  }

  insertEdges(edges: EdgeInsert[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO edges (src_symbol_id, dst_symbol_id, kind, confidence, provenance)
       VALUES (?,?,?,?,?)
       ON CONFLICT(src_symbol_id, dst_symbol_id, kind)
       DO UPDATE SET confidence = MAX(confidence, excluded.confidence)`,
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
function computeQualifiedNames(extraction: FileExtraction): string[] {
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
