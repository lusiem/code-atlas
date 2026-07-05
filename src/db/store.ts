import DatabaseCtor, { type Database } from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initSchema } from './schema.js';
import type {
  FileExtraction,
  LanguageId,
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
    initSchema(this.db);
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
                             end_line, end_col, signature, doc_comment, parent_symbol_id, is_exported)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

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

  countsByLanguage(): Array<{ lang: LanguageId; files: number; symbols: number }> {
    return this.db
      .prepare(
        `SELECT f.lang, COUNT(DISTINCT f.id) AS files, COUNT(s.id) AS symbols
         FROM files f LEFT JOIN symbols s ON s.file_id = f.id
         GROUP BY f.lang ORDER BY files DESC`,
      )
      .all() as Array<{ lang: LanguageId; files: number; symbols: number }>;
  }

  stats(): { files: number; symbols: number; imports: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      files: one(`SELECT COUNT(*) AS n FROM files`),
      symbols: one(`SELECT COUNT(*) AS n FROM symbols`),
      imports: one(`SELECT COUNT(*) AS n FROM imports`),
    };
  }
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
