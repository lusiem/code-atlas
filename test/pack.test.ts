import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { Indexer } from '../src/indexer/indexer.js';
import { createServer } from '../src/server.js';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ts-sample');

async function connect(root: string): Promise<{ client: Client; store: Store }> {
  const config = loadConfig(root);
  const store = new Store(':memory:');
  const indexer = new Indexer(config, store);
  await indexer.run();
  const server = createServer({ config, store, indexer });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, store };
}

async function callText(client: Client, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name: 'context_pack', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((c) => c.text).join('\n');
}

describe('context_pack on ts-sample', () => {
  let client: Client;
  let store: Store;

  beforeAll(async () => {
    ({ client, store } = await connect(FIXTURE_ROOT));
  });

  afterAll(() => {
    store?.close();
    rmSync(join(FIXTURE_ROOT, '.code-atlas'), { recursive: true, force: true });
  });

  it('includes all applicable sections at a generous budget', async () => {
    const text = await callText(client, { name: 'calculate', max_tokens: 8000 });
    expect(text).toContain('function calculate');
    expect(text).toContain('--- source ---');
    expect(text).toContain('--- callers ---');
    expect(text).toContain('function report');
    expect(text).toContain('--- callees ---');
    expect(text).toContain('function add');
    expect(text).not.toContain('omitted (over budget)');
  });

  it('type context shows subtypes for an interface', async () => {
    const text = await callText(client, { name: 'Shape', max_tokens: 8000 });
    expect(text).toContain('--- type context ---');
    expect(text).toContain('subtype class Circle');
  });

  it('task string pulls in possibly relevant symbols', async () => {
    const text = await callText(client, { name: 'calculate', task: 'multiply numbers', max_tokens: 8000 });
    expect(text).toContain('--- possibly relevant to the task ---');
    expect(text).toContain('multiply');
  });
});

describe('context_pack on a route handler', () => {
  let root: string;
  let client: Client;
  let store: Store;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'atlas-pack-'));
    mkdirSync(join(root, 'src'));
    const bigBody = Array.from({ length: 80 }, (_, i) => `  const v${i} = ${i}; total += v${i};`).join('\n');
    writeFileSync(
      join(root, 'src', 'users.ts'),
      'export function listUsers(): string[] {\n  return [];\n}\n' +
        `export function bigHandler(): number {\n  let total = 0;\n${bigBody}\n  return total;\n}\n`,
    );
    writeFileSync(
      join(root, 'src', 'app.ts'),
      "import express from 'express';\nimport { listUsers } from './users.js';\n" +
        'const app = express();\napp.get(\'/users\', listUsers);\n',
    );
    ({ client, store } = await connect(root));
  });

  afterAll(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('surfaces the route the symbol serves', async () => {
    const text = await callText(client, { name: 'listUsers', max_tokens: 8000 });
    expect(text).toContain('--- route ---');
    expect(text).toContain('ROUTE GET /users');
  });

  it('keeps the header and names omitted sections when the budget is tight', async () => {
    const text = await callText(client, { name: 'bigHandler', max_tokens: 500 });
    expect(text).toContain('function bigHandler');
    expect(text).toContain('signature:');
    expect(text).toContain('omitted (over budget):');
    expect(text).toContain('source');
    expect(text).not.toContain('const v40'); // the big body did not make it in
  });
});
