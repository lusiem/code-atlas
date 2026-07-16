import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db/store.js';
import { Indexer } from '../src/indexer/indexer.js';
import { LspManager } from '../src/lsp/manager.js';
import { promoteEdges } from '../src/lsp/promote.js';
import type { ServerSpec } from '../src/lsp/registry.js';

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-lsp.mjs');

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

/** Two same-named functions force the ambiguous-global 0.35 tier for caller -> target. */
async function makeWorkspace(definitionUri: string): Promise<{
  root: string;
  ctx: AppContext;
  store: Store;
  lsp: LspManager;
}> {
  const root = mkdtempSync(join(tmpdir(), 'atlas-promote-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'first.ts'), 'export function target(): number {\n  return 1;\n}\n');
  writeFileSync(join(root, 'src', 'second.ts'), 'export function target(): number {\n  return 2;\n}\n');
  writeFileSync(join(root, 'src', 'main.ts'), 'export function caller(): number {\n  return target();\n}\n');
  const cannedPath = join(root, 'canned.json');
  writeFileSync(
    cannedPath,
    JSON.stringify({
      definition: [
        { uri: definitionUri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } } },
      ],
    }),
  );
  const config = loadConfig(root);
  const store = new Store(':memory:');
  const indexer = new Indexer(config, store);
  await indexer.run();
  const lsp = new LspManager(config.root, { enabled: true, download: false }, [fakeSpec(cannedPath)]);
  await lsp.clientFor('typescript'); // promotion never starts servers itself
  return { root, ctx: { config, store, indexer, lsp }, store, lsp };
}

function edgeBetween(store: Store, srcName: string, dstPath: string) {
  const caller = store.symbolsByExactName(srcName)[0]!;
  return store.edgesFor(caller.id, 'out', ['calls']).find((e) => e.path === dstPath);
}

describe('promoteEdges: confirmation', () => {
  let ws: Awaited<ReturnType<typeof makeWorkspace>>;

  beforeAll(async () => {
    ws = await makeWorkspace('src/first.ts');
  });

  afterAll(async () => {
    await ws.lsp.shutdown();
    ws.store.close();
    rmSync(ws.root, { recursive: true, force: true });
  });

  it('starts from an ambiguous low-confidence edge', () => {
    const edge = edgeBetween(ws.store, 'caller', 'src/first.ts');
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBeLessThanOrEqual(0.6);
    expect(edge!.provenance).toBe('index');
  });

  it('a zero-request budget examines nothing and loses nothing', async () => {
    const stats = await promoteEdges(ws.ctx, { maxRequests: 0, maxMs: 30_000 });
    expect(stats.examined).toBe(0);
  });

  it('promotes the edge when the server confirms the target', async () => {
    const stats = await promoteEdges(ws.ctx, { maxRequests: 50, maxMs: 30_000 });
    expect(stats.confirmed).toBe(1);
    const edge = edgeBetween(ws.store, 'caller', 'src/first.ts');
    expect(edge!.confidence).toBe(1);
    expect(edge!.provenance).toBe('lsp');
  });
});

describe('promoteEdges: correction', () => {
  let ws: Awaited<ReturnType<typeof makeWorkspace>>;

  beforeAll(async () => {
    ws = await makeWorkspace('src/second.ts');
  });

  afterAll(async () => {
    await ws.lsp.shutdown();
    ws.store.close();
    rmSync(ws.root, { recursive: true, force: true });
  });

  it('replaces a wrong edge with the server-verified target', async () => {
    expect(edgeBetween(ws.store, 'caller', 'src/first.ts')).toBeDefined();
    const stats = await promoteEdges(ws.ctx, { maxRequests: 50, maxMs: 30_000 });
    expect(stats.corrected).toBe(1);
    expect(edgeBetween(ws.store, 'caller', 'src/first.ts')).toBeUndefined();
    const corrected = edgeBetween(ws.store, 'caller', 'src/second.ts');
    expect(corrected).toBeDefined();
    expect(corrected!.provenance).toBe('lsp');
    expect(corrected!.confidence).toBe(1);
  });
});
