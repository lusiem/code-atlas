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
import { testsForSymbol } from '../src/analysis/tests-for.js';
import type { AppContext } from '../src/context.js';

let root: string;
let store: Store;
let ctx: AppContext;
let client: Client;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'atlas-tests-for-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(
    join(root, 'src', 'math.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n' +
      'export function unloved(): number {\n  return 0;\n}\n',
  );
  writeFileSync(
    join(root, 'src', 'calc.ts'),
    "import { add } from './math.js';\n" +
      'export function calculate(): number {\n  return add(1, 2);\n}\n',
  );
  // named test function calling into the source through one hop
  writeFileSync(
    join(root, 'test', 'calc.test.ts'),
    "import { calculate } from '../src/calc.js';\n" +
      'export function testCalculate(): number {\n  return calculate();\n}\n',
  );
  // imports the module but never calls anything the resolver can see
  writeFileSync(
    join(root, 'test', 'smoke.test.ts'),
    "import * as math from '../src/math.js';\nexport const modules = [math];\n",
  );

  const config = loadConfig(root);
  store = new Store(':memory:');
  const indexer = new Indexer(config, store);
  await indexer.run();
  ctx = { config, store, indexer };

  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(() => {
  store?.close();
  rmSync(root, { recursive: true, force: true });
});

function symByName(name: string) {
  const rows = store.symbolsByExactName(name);
  expect(rows.length).toBe(1);
  return rows[0]!;
}

describe('testsForSymbol', () => {
  it('finds the named test case through a multi-hop call chain', () => {
    const { hits, targetIsTest } = testsForSymbol(ctx, symByName('add'));
    expect(targetIsTest).toBe(false);
    const direct = hits.filter((h) => h.caseSymbol !== null);
    expect(direct.length).toBe(1);
    expect(direct[0]!.caseSymbol!.name).toBe('testCalculate');
    expect(direct[0]!.testFile).toBe('test/calc.test.ts');
    expect(direct[0]!.depth).toBe(2);
    expect(direct[0]!.via).toContain('calls→');
  });

  it('reports import-chain-only test files as weaker hits', () => {
    const { hits } = testsForSymbol(ctx, symByName('unloved'));
    const direct = hits.filter((h) => h.caseSymbol !== null);
    const imported = hits.filter((h) => h.caseSymbol === null);
    expect(direct.length).toBe(0);
    expect(imported.map((h) => h.testFile)).toContain('test/smoke.test.ts');
  });

  it('flags a target that is itself a test symbol', () => {
    const { targetIsTest } = testsForSymbol(ctx, symByName('testCalculate'));
    expect(targetIsTest).toBe(true);
  });
});

describe('tests_for_symbol MCP tool', () => {
  async function callText(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return content.map((c) => c.text).join('\n');
  }

  it('renders direct hits with the test-case symbol and route', async () => {
    const text = await callText('tests_for_symbol', { name: 'add' });
    expect(text).toContain('tests exercising function add');
    expect(text).toMatch(/TEST function testCalculate.*— via calls→\w+ \[index /);
  });

  it('hedges when nothing reaches the symbol', async () => {
    const text = await callText('tests_for_symbol', { name: 'calculate', max_depth: 1 });
    // depth 1 stops at testCalculate… which IS a hit; use a symbol nothing touches instead
    const none = await callText('tests_for_symbol', { name: 'unloved', min_confidence: 1 });
    expect(text).toContain('TEST');
    expect(none).toContain('import-chain only');
  });
});
