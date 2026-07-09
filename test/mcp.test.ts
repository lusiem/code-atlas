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
      'call_hierarchy',
      'find_asset_references',
      'find_references',
      'generate_diagram',
      'get_dependencies',
      'get_file_outline',
      'get_scene_structure',
      'get_symbol_info',
      'go_to_definition',
      'index_status',
      'project_overview',
      'reindex',
      'search_reflection',
      'search_symbols',
      'semantic_search',
      'trace_path',
      'type_hierarchy',
    ]);
  });

  it('project_overview reports indexed languages', async () => {
    const text = await callText('project_overview');
    expect(text).toContain('typescript: 4 files');
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

  it('find_references lists resolved call sites', async () => {
    const text = await callText('find_references', { name: 'add' });
    expect(text).toContain('definition:');
    expect(text).toMatch(/src\/calculator\.ts:\d+:\d+ call \(resolved/);
  });

  it('call_hierarchy walks callers transitively', async () => {
    const text = await callText('call_hierarchy', { name: 'add', direction: 'in', depth: 2 });
    expect(text).toContain('callers of function add');
    expect(text).toContain('function calculate');
    expect(text).toMatch(/\n {4}function report/); // caller-of-caller, indented deeper
  });

  it('call_hierarchy direction=out lists callees', async () => {
    const text = await callText('call_hierarchy', { name: 'calculate', direction: 'out' });
    expect(text).toContain('calls from function calculate');
    expect(text).toContain('function add');
    expect(text).toContain('function multiply');
  });

  it('type_hierarchy finds implementations', async () => {
    const text = await callText('type_hierarchy', { name: 'Shape', direction: 'sub' });
    expect(text).toContain('subtypes of interface Shape');
    expect(text).toContain('class Circle');
  });

  it('get_dependencies works both directions', async () => {
    const out = await callText('get_dependencies', { path: 'src/calculator.ts' });
    expect(out).toContain('./math  ->  src/math.ts');
    const inbound = await callText('get_dependencies', { path: 'src/math.ts', direction: 'in' });
    expect(inbound).toContain('src/calculator.ts');
  });

  it('trace_path finds a multi-hop call chain', async () => {
    const text = await callText('trace_path', { from_name: 'report', to_name: 'add' });
    expect(text).toContain('call path (2 hops):');
    expect(text).toMatch(/report[\s\S]*-> function calculate[\s\S]*-> function add/);
  });

  it('trace_path reports unreachable pairs honestly', async () => {
    const text = await callText('trace_path', { from_name: 'add', to_name: 'report' });
    expect(text).toContain('no call path');
  });

  it('generate_diagram kind=imports draws the file import graph', async () => {
    const text = await callText('generate_diagram', { kind: 'imports' });
    expect(text).toContain('```mermaid');
    expect(text).toContain('flowchart LR');
    expect(text).toContain('subgraph d0["src"]');
    expect(text).toContain('["calculator.ts"]');
    // calculator.ts -> math.ts and math.ts -> logger.ts edges exist
    const arrows = text.match(/n\d+ --> n\d+/g) ?? [];
    expect(arrows.length).toBeGreaterThanOrEqual(3);
  });

  it('generate_diagram kind=imports granularity=dir collapses to directories', async () => {
    const text = await callText('generate_diagram', { kind: 'imports', granularity: 'dir' });
    // every fixture file lives in src/, so there is nothing cross-directory to draw
    expect(text).toContain('single directory');
  });

  it('generate_diagram kind=calls centers on a symbol', async () => {
    const text = await callText('generate_diagram', { kind: 'calls', name: 'calculate', depth: 2 });
    expect(text).toContain('call graph around function calculate');
    expect(text).toContain('```mermaid');
    expect(text).toContain('["report"]');
    expect(text).toContain('["add"]');
    expect(text).toContain('classDef focus');
  });

  it('generate_diagram kind=types labels inheritance edges', async () => {
    const text = await callText('generate_diagram', { kind: 'types', name: 'Shape' });
    expect(text).toContain('type hierarchy around interface Shape');
    expect(text).toContain('flowchart BT');
    expect(text).toContain('["Circle"]');
    expect(text).toMatch(/n\d+ -\.?-?>?\|implements\| n\d+/);
  });

  it('generate_diagram kind=call_path renders the chain', async () => {
    const text = await callText('generate_diagram', { kind: 'call_path', from_name: 'report', to_name: 'add' });
    expect(text).toContain('call path report -> add (2 hops):');
    expect(text).toContain('["report<br/>src/calculator.ts:12"]');
    expect(text).toMatch(/n0 --> n1[\s\S]*n1 --> n2/);
  });

  it('generate_diagram kind=types on a non-type redirects to calls', async () => {
    const text = await callText('generate_diagram', { kind: 'types', name: 'add' });
    expect(text).toContain('function add is not a type');
    expect(text).toContain('call graph may be what you want');
  });

  it('generate_diagram kind=types on a standalone type says so', async () => {
    const text = await callText('generate_diagram', { kind: 'types', name: 'Color' });
    expect(text).toContain('enum Color: no supertypes or subtypes in the index — it stands alone');
  });

  it('generate_diagram kind=calls on a non-callable redirects to types', async () => {
    const text = await callText('generate_diagram', { kind: 'calls', name: 'Shape' });
    expect(text).toContain('interface Shape is not callable');
    expect(text).toContain('type hierarchy may be what you want');
  });

  it('call_hierarchy explains an empty result per direction', async () => {
    const text = await callText('call_hierarchy', { name: 'multiply', direction: 'out' });
    expect(text).toContain('it calls nothing the resolver could see');
  });

  it('type_hierarchy explains an empty result per direction', async () => {
    const text = await callText('type_hierarchy', { name: 'Color', direction: 'sub' });
    expect(text).toContain('enum Color: no subtypes in the index');
  });

  it('generate_diagram reports missing symbols gracefully', async () => {
    const text = await callText('generate_diagram', { kind: 'calls', name: 'doesNotExist' });
    expect(text).toContain('no symbol named "doesNotExist"');
  });

  it('semantic_search degrades to keyword-only without an embedder', async () => {
    const text = await callText('semantic_search', { query: 'add' });
    expect(text).toContain('[fts]');
    expect(text).toContain('function add');
    expect(text).toContain('keyword-only: embeddings disabled');
  });
});
