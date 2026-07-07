import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { Indexer } from '../src/indexer/indexer.js';

let root: string;
let store: Store;
let indexer: Indexer;

function write(rel: string, content: string): void {
  writeFileSync(join(root, rel), content);
}

function symbolId(name: string): number | null {
  const rows = store.searchSymbols(name, { limit: 10, offset: 0 });
  return rows.find((r) => r.name === name)?.id ?? null;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'atlas-incr-'));
  write('a.ts', 'export function alpha(): number {\n  return 1;\n}\n');
  write(
    'b.ts',
    "import { alpha } from './a.js';\n\nexport function beta(): number {\n  return alpha();\n}\n",
  );
  store = new Store(':memory:');
  indexer = new Indexer(loadConfig(root), store);
  await indexer.run();
});

afterAll(() => {
  store?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('incremental reindex + scoped resolution', () => {
  it('cold index runs a full resolution pass', () => {
    expect(indexer.progress.resolve?.mode).toBe('full');
    const alphaId = symbolId('alpha')!;
    const incoming = store.edgesFor(alphaId, 'in', ['calls']);
    expect(incoming.map((e) => e.name)).toContain('beta');
  });

  it('re-resolves dependents when a symbol is renamed away', async () => {
    write('a.ts', 'export function gamma(): number {\n  return 2;\n}\n');
    await indexer.applyChanges(['a.ts']);

    expect(indexer.progress.resolve?.mode).toBe('incremental');
    expect(symbolId('alpha')).toBeNull();
    expect(symbolId('gamma')).not.toBeNull();

    // b.ts still calls alpha() — its stale resolution must be gone, not dangling
    const betaId = symbolId('beta')!;
    expect(store.edgesFor(betaId, 'out', ['calls'])).toHaveLength(0);
    const unresolved = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM occurrences o JOIN files f ON f.id = o.file_id
         WHERE f.path = 'b.ts' AND o.name = 'alpha' AND o.resolved_symbol_id IS NOT NULL`,
      )
      .get() as { n: number };
    expect(unresolved.n).toBe(0);
  });

  it('resolves a newly added file against existing symbols', async () => {
    write('c.ts', "import { gamma } from './a.js';\n\nexport const val = gamma();\n");
    await indexer.applyChanges(['c.ts']);

    expect(indexer.progress.resolve?.mode).toBe('incremental');
    const gammaId = symbolId('gamma')!;
    const incoming = store.edgesFor(gammaId, 'in', ['calls']);
    expect(incoming.some((e) => e.path === 'c.ts')).toBe(true);
  });

  it('cleans up dependents when a file is deleted', async () => {
    rmSync(join(root, 'a.ts'));
    await indexer.applyChanges(['a.ts']);

    expect(symbolId('gamma')).toBeNull();
    expect(store.getFileByPath('a.ts')).toBeUndefined();
    const resolved = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM occurrences o JOIN files f ON f.id = o.file_id
         WHERE f.path = 'c.ts' AND o.name = 'gamma' AND o.resolved_symbol_id IS NOT NULL`,
      )
      .get() as { n: number };
    expect(resolved.n).toBe(0);
  });

  it('no-op batches leave the resolution pass untouched', async () => {
    const before = indexer.progress.resolve;
    await indexer.applyChanges(['b.ts']); // unchanged content
    expect(indexer.progress.resolve).toBe(before);
  });

  it('recovers with a full pass when a prior session died before resolving', async () => {
    // simulate: file rows committed (sets resolve_dirty) but the resolution
    // pass never ran — e.g. the server was killed mid-batch
    store.setMeta('resolve_dirty', '1');
    await indexer.applyChanges(['b.ts']); // no content change, but stale flag set
    expect(indexer.progress.resolve?.mode).toBe('full');
    expect(store.getMeta('resolve_dirty')).toBe('0');
  });
});
