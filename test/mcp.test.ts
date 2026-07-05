import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { Indexer } from '../src/indexer/indexer.js';
import { createServer } from '../src/server.js';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ts-sample');

let client: Client;
let store: Store;

beforeAll(async () => {
  const config = loadConfig(FIXTURE_ROOT);
  store = new Store(':memory:');
  const indexer = new Indexer(config, store);
  await indexer.run();

  const server = createServer({ config, store, indexer });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(() => {
  store?.close();
  rmSync(join(FIXTURE_ROOT, '.code-atlas'), { recursive: true, force: true });
});

async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((c) => c.text).join('\n');
}

describe('MCP server end-to-end', () => {
  it('lists the expected tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'ast_query',
      'get_file_outline',
      'get_symbol_info',
      'index_status',
      'project_overview',
      'reindex',
      'search_symbols',
    ]);
  });

  it('project_overview reports indexed languages', async () => {
    const text = await callText('project_overview');
    expect(text).toContain('typescript: 3 files');
    expect(text).toContain('index: ready');
  });

  it('search_symbols finds definitions across files', async () => {
    const text = await callText('search_symbols', { query: 'Circle' });
    expect(text).toContain('class Circle');
    expect(text).toContain('src/math.ts:');
  });

  it('search_symbols respects kind filter', async () => {
    const text = await callText('search_symbols', { query: 'Circle', kind: 'interface' });
    expect(text).toContain('no symbols matching');
  });

  it('get_file_outline renders a nested outline', async () => {
    const text = await callText('get_file_outline', { path: 'src/math.ts' });
    expect(text).toMatch(/class Circle/);
    expect(text).toMatch(/\n {2}\d+: method area/); // indented under Circle
    expect(text).toContain('enum Color');
  });

  it('get_symbol_info by name returns docs and source', async () => {
    const text = await callText('get_symbol_info', { name: 'add', include_source: true });
    expect(text).toContain('function add');
    expect(text).toContain('Adds two numbers.');
    expect(text).toContain('return a + b;');
  });

  it('get_symbol_info by position finds the innermost symbol', async () => {
    const text = await callText('get_symbol_info', { path: 'src/math.ts', line: 26 });
    expect(text).toContain('Circle.area');
  });

  it('ast_query finds structural patterns', async () => {
    const text = await callText('ast_query', {
      pattern: '(class_declaration name: (type_identifier) @cls)',
      lang: 'typescript',
    });
    expect(text).toContain('src/math.ts:20 @cls  Circle');
  });

  it('ast_query rejects bad queries gracefully', async () => {
    const text = await callText('ast_query', { pattern: '(nonsense_node) @x', lang: 'typescript' });
    expect(text).toContain('invalid query');
  });
});
