import type { Database } from 'better-sqlite3';
import { PACKAGE_VERSION } from '../version.js';

/**
 * Bump when the schema changes. On mismatch the store first tries the
 * stepwise MIGRATIONS below and falls back to a drop-and-rebuild (the index
 * is a cache — a rebuild only costs one full sweep).
 */
export const SCHEMA_VERSION = 3;

/** DDL for the embedding chunk tables (v3), shared by createAll and MIGRATIONS[2]. */
const CHUNKS_DDL = `
    CREATE TABLE chunks (
      id        INTEGER PRIMARY KEY,
      file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      text_hash TEXT NOT NULL,             -- sha1 of content; reuse vectors across reindexes
      content   TEXT NOT NULL,             -- what gets embedded (signature + doc + capped body)
      embedded  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_chunks_file ON chunks(file_id);
    CREATE INDEX idx_chunks_pending ON chunks(embedded) WHERE embedded = 0;

    CREATE TABLE chunk_vectors (
      chunk_id  INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL              -- float32[dims], dims in meta 'embedding_dims'
    );
`;

/**
 * In-place migration from version N to N+1, run inside a transaction.
 * Leave a version out to force drop-and-rebuild for upgrades crossing it.
 * (2->3 is deliberately absent: creating the chunk tables in place would
 * leave them empty forever — chunks only fill when a file reindexes, and
 * unchanged hashes never do. A rebuild reindexes everything once.)
 */
const MIGRATIONS: Record<number, (db: Database) => void> = {};

/**
 * Identity of the code that produced the index rows. Extractor and resolver
 * output changes between releases even when the schema doesn't, so a version
 * bump invalidates all indexed data (schema stays, next sweep reindexes).
 */
export const INDEX_GENERATION = PACKAGE_VERSION;

export function configurePragmas(db: Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
}

/**
 * Bring the schema up to date. Returns 'ready' when the db is usable, or
 * 'rebuild' when it must be recreated from scratch — the caller should then
 * delete the database FILE and reopen rather than call rebuildSchema: DROP
 * TABLE on a multi-GB-of-pages index takes minutes in SQLite, unlinking is
 * instant. rebuildSchema exists for :memory: databases, where dropping is
 * cheap and there is no file to delete.
 */
export function prepareSchema(db: Database): 'ready' | 'rebuild' {
  configurePragmas(db);

  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`)
    .get() as { name: string } | undefined;
  if (!row) {
    createAll(db);
    return 'ready';
  }

  const version = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as
    | { value: string }
    | undefined;
  let current = version ? Number(version.value) : NaN;
  while (current < SCHEMA_VERSION && MIGRATIONS[current]) {
    const migrate = MIGRATIONS[current]!;
    const next = current + 1;
    db.transaction(() => {
      migrate(db);
      db.prepare(`UPDATE meta SET value = ? WHERE key='schema_version'`).run(String(next));
    })();
    current = next;
  }
  if (current === SCHEMA_VERSION && generationMatches(db)) return 'ready';
  // schema too old to migrate, or rows written by a different release
  return 'rebuild';
}

/** In-place drop-and-recreate; only sensible for :memory: databases. */
export function rebuildSchema(db: Database): void {
  dropAll(db);
  createAll(db);
}

function generationMatches(db: Database): boolean {
  const row = db.prepare(`SELECT value FROM meta WHERE key='index_generation'`).get() as
    | { value: string }
    | undefined;
  return row?.value === INDEX_GENERATION;
}

function dropAll(db: Database): void {
  db.exec(`
    DROP TABLE IF EXISTS chunk_vectors;
    DROP TABLE IF EXISTS chunks;
    DROP TABLE IF EXISTS symbols_fts;
    DROP TABLE IF EXISTS occurrences;
    DROP TABLE IF EXISTS edges;
    DROP TABLE IF EXISTS imports;
    DROP TABLE IF EXISTS symbols;
    DROP TABLE IF EXISTS files;
    DROP TABLE IF EXISTS meta;
  `);
}

function createAll(db: Database): void {
  db.exec(`
    CREATE TABLE meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE files (
      id         INTEGER PRIMARY KEY,
      path       TEXT NOT NULL UNIQUE,   -- relative to root, forward slashes
      lang       TEXT NOT NULL,
      hash       TEXT NOT NULL,          -- sha1 of contents
      size       INTEGER NOT NULL,
      mtime_ms   REAL NOT NULL,
      indexed_at INTEGER NOT NULL        -- unix ms
    );

    CREATE TABLE symbols (
      id               INTEGER PRIMARY KEY,
      file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name             TEXT NOT NULL,
      qualified_name   TEXT NOT NULL,
      kind             TEXT NOT NULL,
      start_line       INTEGER NOT NULL, -- 1-based
      start_col        INTEGER NOT NULL, -- 0-based
      end_line         INTEGER NOT NULL,
      end_col          INTEGER NOT NULL,
      signature        TEXT,
      doc_comment      TEXT,
      parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
      is_exported      INTEGER NOT NULL DEFAULT 0,
      bases            TEXT                -- JSON [{name, kind}] of declared base types, or NULL
    );
    CREATE INDEX idx_symbols_file ON symbols(file_id);
    CREATE INDEX idx_symbols_name ON symbols(name);
    CREATE INDEX idx_symbols_qname ON symbols(qualified_name);

    CREATE TABLE imports (
      id               INTEGER PRIMARY KEY,
      file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      specifier        TEXT NOT NULL,
      names            TEXT NOT NULL,    -- JSON array
      start_line       INTEGER NOT NULL,
      resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL
    );
    CREATE INDEX idx_imports_file ON imports(file_id);
    CREATE INDEX idx_imports_spec ON imports(specifier);
    CREATE INDEX idx_imports_resolved ON imports(resolved_file_id);

    CREATE TABLE occurrences (
      id                 INTEGER PRIMARY KEY,
      file_id            INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name               TEXT NOT NULL,
      role               TEXT NOT NULL,  -- ref|call|write|import
      start_line         INTEGER NOT NULL,
      start_col          INTEGER NOT NULL,
      end_line           INTEGER NOT NULL,
      end_col            INTEGER NOT NULL,
      resolved_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
      confidence         REAL
    );
    CREATE INDEX idx_occurrences_file ON occurrences(file_id);
    CREATE INDEX idx_occurrences_name ON occurrences(name);
    CREATE INDEX idx_occurrences_resolved ON occurrences(resolved_symbol_id);

    CREATE TABLE edges (
      src_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      dst_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,       -- calls|imports|extends|implements|overrides|attaches
      confidence    REAL NOT NULL,
      provenance    TEXT NOT NULL,       -- index|lsp|engine
      PRIMARY KEY (src_symbol_id, dst_symbol_id, kind)
    ) WITHOUT ROWID;
    CREATE INDEX idx_edges_dst ON edges(dst_symbol_id);

    CREATE VIRTUAL TABLE symbols_fts USING fts5(
      name, qualified_name, doc_comment,
      content='symbols', content_rowid='id',
      tokenize = "unicode61 tokenchars '_$'"
    );
    CREATE TRIGGER symbols_ai AFTER INSERT ON symbols BEGIN
      INSERT INTO symbols_fts(rowid, name, qualified_name, doc_comment)
      VALUES (new.id, new.name, new.qualified_name, new.doc_comment);
    END;
    CREATE TRIGGER symbols_ad AFTER DELETE ON symbols BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, doc_comment)
      VALUES ('delete', old.id, old.name, old.qualified_name, old.doc_comment);
    END;
    ${CHUNKS_DDL}
  `);
  db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
    String(SCHEMA_VERSION),
  );
  db.prepare(`INSERT INTO meta (key, value) VALUES ('index_generation', ?)`).run(INDEX_GENERATION);
}
