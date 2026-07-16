import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { Indexer } from '../src/indexer/indexer.js';
import { createServer } from '../src/server.js';
import { findSimilar, jaccard, shingleSet } from '../src/analysis/similarity.js';
import type { AppContext } from '../src/context.js';

const BODY = `  const first = user.first.trim().toLowerCase();
  const last = user.last.trim().toLowerCase();
  if (first.length === 0 && last.length === 0) {
    return 'anonymous';
  }
  return (first + ' ' + last).trim();
`;

describe('shingleSet / jaccard', () => {
  it('identical text scores 1', () => {
    const a = shingleSet(BODY);
    expect(jaccard(a, a)).toBe(1);
  });

  it('unrelated text scores near 0', () => {
    const a = shingleSet(BODY);
    const b = shingleSet('for (let i = 0; i < n; i++) { total += weights[i] * values[i]; }');
    expect(jaccard(a, b)).toBeLessThan(0.05);
  });

  it('near-identical text scores high', () => {
    const a = shingleSet(`function formatUserName(user) {\n${BODY}}`);
    const b = shingleSet(`function renderDisplayName(user) {\n${BODY}}`);
    expect(jaccard(a, b)).toBeGreaterThan(0.6);
  });
});

describe('findSimilar (shingle fallback, no embedder)', () => {
  let root: string;
  let store: Store;
  let ctx: AppContext;
  let client: Client;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'atlas-sim-'));
    mkdirSync(join(root, 'src'));
    const fn = (name: string) =>
      `export function ${name}(user: { first: string; last: string }): string {\n${BODY}}\n`;
    writeFileSync(join(root, 'src', 'a.ts'), fn('formatUserName'));
    writeFileSync(join(root, 'src', 'b.ts'), fn('renderDisplayName'));
    writeFileSync(
      join(root, 'src', 'c.ts'),
      'export function parseConfig(raw: string): Record<string, number> {\n' +
        '  const out: Record<string, number> = {};\n' +
        '  for (const line of raw.split(/\\r?\\n/)) {\n' +
        '    const [key, value] = line.split(\'=\');\n' +
        '    if (key && value) out[key.trim()] = Number(value);\n' +
        '  }\n  return out;\n}\n',
    );

    const config = loadConfig(root);
    store = new Store(':memory:');
    const indexer = new Indexer(config, store);
    await indexer.run();
    ctx = { config, store, indexer };

    const server = createServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  afterAll(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the near-duplicate and skips unrelated code', async () => {
    const sym = store.symbolsByExactName('formatUserName')[0]!;
    const result = await findSimilar(ctx, { symbol: sym, k: 10, minSimilarity: 0.8 });
    if ('error' in result) throw new Error(result.error);
    const names = result.hits.map((h) => h.symbol.name);
    expect(names).toContain('renderDisplayName');
    expect(names).not.toContain('parseConfig');
    expect(result.hits[0]!.metric).toBe('jaccard');
    expect(result.note).toContain('embeddings not ready');
  });

  it('works from a raw snippet', async () => {
    const result = await findSimilar(ctx, {
      snippet: `function anything(user) {\n${BODY}}`,
      k: 5,
      minSimilarity: 0.8,
    });
    if ('error' in result) throw new Error(result.error);
    const names = result.hits.map((h) => h.symbol.name);
    expect(names).toContain('formatUserName');
    expect(names).toContain('renderDisplayName');
  });

  it('MCP tool renders scores and the degradation note', async () => {
    const result = await client.callTool({
      name: 'find_similar_code',
      arguments: { name: 'formatUserName' },
    });
    const text = (result.content as Array<{ text: string }>).map((c) => c.text).join('\n');
    expect(text).toContain('similar to function formatUserName');
    expect(text).toMatch(/\[jaccard 0\.\d+\] function renderDisplayName/);
    expect(text).toContain('(embeddings not ready');
  });
});
