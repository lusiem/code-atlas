import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INDEX_GENERATION, SCHEMA_VERSION } from '../src/db/schema.js';
import { Store } from '../src/db/store.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-schema-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function insertRawFile(dbPath: string): void {
  const db = new DatabaseCtor(dbPath);
  db.prepare(
    `INSERT INTO files (path, lang, hash, size, mtime_ms, indexed_at) VALUES ('x.ts','typescript','h',1,0,0)`,
  ).run();
  db.close();
}

function setMetaRaw(dbPath: string, key: string, value: string): void {
  const db = new DatabaseCtor(dbPath);
  db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run(value, key);
  db.close();
}

describe('schema versioning', () => {
  it('wipes indexed data when the index generation changes', () => {
    const dbPath = join(dir, 'gen.db');
    new Store(dbPath).close();
    insertRawFile(dbPath);
    setMetaRaw(dbPath, 'index_generation', '0.0.0-previous');

    const store = new Store(dbPath);
    expect(store.stats().files).toBe(0);
    expect(store.getMeta('index_generation')).toBe(INDEX_GENERATION);
    expect(store.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
    store.close();
  });

  it('keeps data when schema version and generation match', () => {
    const dbPath = join(dir, 'keep.db');
    new Store(dbPath).close();
    insertRawFile(dbPath);

    const store = new Store(dbPath);
    expect(store.stats().files).toBe(1);
    store.close();
  });

  it('drops and rebuilds on an unmigratable schema version', () => {
    const dbPath = join(dir, 'old.db');
    new Store(dbPath).close();
    insertRawFile(dbPath);
    setMetaRaw(dbPath, 'schema_version', '1');

    const store = new Store(dbPath);
    expect(store.stats().files).toBe(0);
    expect(store.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
    store.close();
  });
});
