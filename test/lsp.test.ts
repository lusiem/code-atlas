import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db/store.js';
import { Indexer } from '../src/indexer/indexer.js';
import { LspManager } from '../src/lsp/manager.js';
import { lspCallHierarchy, lspHoverFor, lspReferences } from '../src/lsp/overlay.js';
import type { ServerSpec } from '../src/lsp/registry.js';
import type { SymbolRow } from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, 'fixtures', 'ts-sample');
const FAKE_SERVER = join(HERE, 'helpers', 'fake-lsp.mjs');

let tmp: string;
let store: Store;
let ctx: AppContext;
let lsp: LspManager;

function sym(name: string): SymbolRow {
  const rows = store.searchSymbols(name, { limit: 10, offset: 0 });
  const hit = rows.find((r) => r.name === name);
  if (!hit) throw new Error(`fixture symbol missing: ${name}`);
  return hit;
}

const CANNED = {
  references: [
    { uri: 'src/calculator.ts', range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } } },
    { uri: 'src/calculator.ts', range: { start: { line: 4, character: 14 }, end: { line: 4, character: 17 } } },
  ],
  definition: [
    { uri: 'src/math.ts', range: { start: { line: 4, character: 16 }, end: { line: 4, character: 19 } } },
  ],
  hover: { contents: { kind: 'markdown', value: '```typescript\nfunction add(a: number, b: number): number\n```' } },
  hierarchyRoot: {
    name: 'add', kind: 12, uri: 'src/math.ts',
    range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } },
    selectionRange: { start: { line: 4, character: 16 }, end: { line: 4, character: 19 } },
  },
  incoming: [
    {
      name: 'calculate', kind: 12, uri: 'src/calculator.ts',
      range: { start: { line: 3, character: 0 }, end: { line: 8, character: 1 } },
      selectionRange: { start: { line: 3, character: 16 }, end: { line: 3, character: 25 } },
    },
  ],
  outgoing: [],
};

function fakeSpec(cannedPath: string): ServerSpec {
  return {
    id: 'fake-ts',
    languages: ['typescript', 'tsx', 'javascript'],
    detectNames: [],
    pathArgs: [],
    languageIds: { typescript: 'typescript' },
    installHint: 'n/a',
    launch: { command: process.execPath, args: [FAKE_SERVER, cannedPath] },
  };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'atlas-lsp-'));
  const cannedPath = join(tmp, 'canned.json');
  writeFileSync(cannedPath, JSON.stringify(CANNED));

  const config = loadConfig(FIXTURE_ROOT);
  store = new Store(':memory:');
  const indexer = new Indexer(config, store);
  await indexer.run();
  lsp = new LspManager(FIXTURE_ROOT, { enabled: true, download: false }, [fakeSpec(cannedPath)]);
  ctx = { config, store, indexer, lsp };
});

afterAll(async () => {
  await lsp?.shutdown();
  store?.close();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(join(FIXTURE_ROOT, '.code-atlas'), { recursive: true, force: true });
});

describe('lsp overlay', () => {
  it('returns precise references from the server', async () => {
    const refs = await lspReferences(ctx, sym('add'));
    expect(refs).not.toBeNull();
    expect(refs!.map((r) => `${r.path}:${r.line}:${r.col}`)).toEqual([
      'src/calculator.ts:1:9',
      'src/calculator.ts:5:14',
    ]);
  });

  it('returns hover text', async () => {
    const hover = await lspHoverFor(ctx, sym('add'));
    expect(hover).toContain('function add(a: number, b: number): number');
  });

  it('renders the call hierarchy and caches lsp edges', async () => {
    const add = sym('add');
    const lines = await lspCallHierarchy(ctx, add, 'in', 2, 25);
    expect(lines).not.toBeNull();
    expect(lines![0]).toContain('calculate');
    expect(lines![0]).toContain('[lsp 1.00]');

    const incoming = store.edgesFor(add.id, 'in', ['calls']);
    const fromCalculate = incoming.find((e) => e.name === 'calculate');
    expect(fromCalculate?.provenance).toBe('lsp');
    expect(fromCalculate?.confidence).toBe(1);
  });

  it('reports the server as running', () => {
    expect(lsp.statusLines().join('\n')).toContain('fake-ts (typescript/tsx/javascript): running');
  });

  it('marks a crashing server structural-only after repeated failures', async () => {
    const crashSpec: ServerSpec = {
      ...fakeSpec('unused'),
      id: 'crasher',
      languages: ['python'],
      launch: { command: process.execPath, args: ['-e', 'process.exit(1)'] },
    };
    const mgr = new LspManager(FIXTURE_ROOT, { enabled: true, download: false }, [crashSpec]);
    for (let i = 0; i < 3; i++) {
      expect(await mgr.clientFor('python')).toBeNull();
    }
    expect(await mgr.clientFor('python')).toBeNull(); // now short-circuits
    expect(mgr.statusLines().join('\n')).toContain('structural-only');
    await mgr.shutdown();
  });

  it('yields null when disabled so tools fall back to the index', async () => {
    const off = new LspManager(FIXTURE_ROOT, { enabled: false, download: false }, []);
    expect(await off.clientFor('typescript')).toBeNull();
    expect(off.statusLines()).toEqual(['lsp: disabled']);
  });
});
