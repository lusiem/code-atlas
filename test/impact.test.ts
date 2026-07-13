import { execFileSync } from 'node:child_process';
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

/**
 * Fixture: db <- service <- api call chain, with a test file exercising the
 * service. Impact of the bottom of the chain must reach all three, tests first.
 */
const DB_TS = `export function query(sql: string): string[] {
  return [sql];
}
`;
const SERVICE_TS = `import { query } from './db.js';

export function getUser(id: string): string[] {
  return query('select ' + id);
}
`;
const API_TS = `import { getUser } from './service.js';

export function handler(id: string): string[] {
  return getUser(id);
}
`;
const TEST_TS = `import { getUser } from '../src/service.js';

function verify(): string[] {
  return getUser('42');
}

verify();
`;

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let root: string;
let store: Store;
let client: Client;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'atlas-impact-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'src', 'db.ts'), DB_TS);
  writeFileSync(join(root, 'src', 'service.ts'), SERVICE_TS);
  writeFileSync(join(root, 'src', 'api.ts'), API_TS);
  writeFileSync(join(root, 'test', 'service.test.ts'), TEST_TS);

  const config = loadConfig(root);
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
  rmSync(root, { recursive: true, force: true });
});

async function callImpact(args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name: 'change_impact', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((c) => c.text).join('\n');
}

describe('is_test classification through the indexer', () => {
  it('flags the test file and only the test file', () => {
    const flags = new Map(store.listFiles().map((f) => [f.path, Boolean(f.isTest)]));
    expect(flags.get('test/service.test.ts')).toBe(true);
    expect(flags.get('src/db.ts')).toBe(false);
    expect(flags.get('src/service.ts')).toBe(false);
  });
});

describe('change_impact', () => {
  it('symbol mode walks transitive callers and flags test files first', async () => {
    const text = await callImpact({ name: 'query' });
    expect(text).toContain('seeds: 1 symbol (function query)');
    expect(text).toContain('src/service.ts');
    expect(text).toContain('src/api.ts');
    expect(text).toContain('TEST test/service.test.ts');
    // tests are listed before non-test files
    expect(text.indexOf('test/service.test.ts')).toBeLessThan(text.indexOf('src/api.ts'));
    // depth: service is one call away
    expect(text).toMatch(/src\/service\.ts.*depth 1/);
  });

  it('files mode seeds every symbol in the given files', async () => {
    const text = await callImpact({ files: ['src/db.ts'] });
    expect(text).toContain('src/service.ts');
    expect(text).toContain('TEST test/service.test.ts');
    // the seed file itself is a cause, not an effect
    expect(text).not.toMatch(/^\s*src\/db\.ts/m);
  });

  it('tests_only filters to test files', async () => {
    const text = await callImpact({ name: 'query', tests_only: true });
    expect(text).toContain('TEST test/service.test.ts');
    expect(text).not.toMatch(/^\s*src\/api\.ts/m);
  });

  it('a strict confidence floor prunes heuristic edges', async () => {
    const text = await callImpact({ name: 'query', min_confidence: 0.99 });
    // structural edges are < 0.99; only the import-chain layer remains
    expect(text).not.toMatch(/via calls→/);
  });

  it('max_depth=1 stops at direct callers', async () => {
    const text = await callImpact({ name: 'query', max_depth: 1 });
    expect(text).toMatch(/src\/service\.ts.*depth 1/);
    expect(text).not.toMatch(/src\/api\.ts.*via calls→/);
  });

  it('unknown symbol answers with the standard message', async () => {
    const text = await callImpact({ name: 'noSuchThing' });
    expect(text).toContain('no symbol named');
  });

  it('unindexed files are reported', async () => {
    const text = await callImpact({ files: ['src/nope.ts'] });
    expect(text).toContain('none of the given files are indexed');
  });
});

describe.skipIf(!hasGit())('change_impact git mode', () => {
  it('no-args analyzes the uncommitted diff', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    git('add', '.');
    git('commit', '-m', 'init');
    // touch the bottom of the call chain, uncommitted
    writeFileSync(join(root, 'src', 'db.ts'), DB_TS.replace('[sql]', '[sql, sql]'));

    const text = await callImpact({});
    expect(text).toContain('git: 1 modified');
    expect(text).toContain('TEST test/service.test.ts');
    expect(text).toContain('src/service.ts');
    // seed file changed on disk after indexing — staleness must be called out
    expect(text).toContain('index stale');
  });

  it('clean tree says so', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('add', '.');
    git('commit', '-m', 'wip');
    const text = await callImpact({});
    expect(text).toContain('working tree is clean');
  });
});
