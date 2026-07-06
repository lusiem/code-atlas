import type { Database } from 'better-sqlite3';

/**
 * Bump when the schema or extractor output shape changes incompatibly;
 * the store drops and rebuilds the index when versions differ.
 */
export const SCHEMA_VERSION = 2;

export function initSchema(db: Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`)
    .get() as { name: string } | undefined;
  if (row) {
    const version = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as
      | { value: string }
      | undefined;
    if (version && Number(version.value) === SCHEMA_VERSION) return;
    dropAll(db);
  }
  createAll(db);
}

function dropAll(db: Database): void {
  db.exec(`
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
  `);
  db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
    String(SCHEMA_VERSION),
  );
}
