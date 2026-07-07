import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { Indexer } from '../src/indexer/indexer.js';
import { Watcher } from '../src/indexer/watcher.js';

let root: string;
let store: Store;
let indexer: Indexer;
let watcher: Watcher;

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function hasSymbol(name: string): boolean {
  return store.searchSymbols(name, { limit: 5, offset: 0 }).some((r) => r.name === name);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'atlas-watch-'));
  writeFileSync(join(root, 'a.ts'), 'export function alpha(): number {\n  return 1;\n}\n');
  writeFileSync(
    join(root, 'b.ts'),
    "import { alpha } from './a.js';\n\nexport function beta(): number {\n  return alpha();\n}\n",
  );
  store = new Store(':memory:');
  indexer = new Indexer(loadConfig(root), store);
  await indexer.run();
  watcher = new Watcher(loadConfig(root), indexer, { debounceMs: 60 });
  watcher.start();
  // chokidar needs a beat to arm its platform watchers
  await new Promise((r) => setTimeout(r, 300));
});

afterAll(async () => {
  await watcher?.stop();
  store?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('watcher', () => {
  it('picks up an edited file and re-resolves incrementally', { timeout: 15000 }, async () => {
    writeFileSync(
      join(root, 'a.ts'),
      'export function alpha(): number {\n  return 1;\n}\n\nexport function delta(): number {\n  return alpha();\n}\n',
    );
    await until(() => hasSymbol('delta'));
    expect(indexer.progress.resolve?.mode).toBe('incremental');
    expect(watcher.status.batches).toBeGreaterThanOrEqual(1);
  });

  it('picks up new and deleted files', { timeout: 15000 }, async () => {
    writeFileSync(join(root, 'c.ts'), 'export const gamma = 3;\n');
    await until(() => store.getFileByPath('c.ts') !== undefined);

    rmSync(join(root, 'c.ts'));
    await until(() => store.getFileByPath('c.ts') === undefined);
  });

  it('falls back to a full sweep when .gitignore changes', { timeout: 15000 }, async () => {
    writeFileSync(join(root, '.gitignore'), 'b.ts\n');
    await until(() => store.getFileByPath('b.ts') === undefined);
    expect(store.getFileByPath('a.ts')).toBeDefined();
  });
});
