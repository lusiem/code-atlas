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
import { renamedPath } from '../src/git/churn.js';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GIT = hasGit();

describe('renamedPath', () => {
  it('keeps the new side of rename records', () => {
    expect(renamedPath('src/{old => new}/util.ts')).toBe('src/new/util.ts');
    expect(renamedPath('old.ts => new.ts')).toBe('new.ts');
    expect(renamedPath('src/plain.ts')).toBe('src/plain.ts');
  });
});

describe('find_dead_code', () => {
  let root: string;
  let store: Store;
  let client: Client;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'atlas-health-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test'));
    // used export, unreferenced private, unreferenced export, dynamic-name case
    writeFileSync(
      join(root, 'src', 'lib.ts'),
      'export function used(): number {\n  return helper();\n}\n' +
        'function helper(): number {\n  return 1;\n}\n' +
        'function orphan(): number {\n  return 2;\n}\n' +
        'export function neverImported(): number {\n  return 3;\n}\n' +
        'function maybeDynamic(): number {\n  return 4;\n}\n',
    );
    writeFileSync(
      join(root, 'src', 'app.ts'),
      "import { used } from './lib.js';\n" +
        'export function run(): number {\n  return used();\n}\n' +
        '// a name-only mention the resolver cannot bind:\n' +
        "const table: Record<string, unknown> = {};\nconst pick = table['maybeDynamic'];\n" +
        'export const picked = pick;\n',
    );
    // express route handler must be excluded
    writeFileSync(
      join(root, 'src', 'routes.ts'),
      "import express from 'express';\n" +
        'const app = express();\n' +
        'export function handleUsers(): void {}\n' +
        "app.get('/users', handleUsers);\n",
    );
    writeFileSync(
      join(root, 'test', 'lib.test.ts'),
      'export function unusedTestHelper(): number {\n  return 9;\n}\n',
    );

    const config = loadConfig(root);
    store = new Store(':memory:');
    const indexer = new Indexer(config, store);
    await indexer.run();
    const server = createServer({ config, store, indexer });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  afterAll(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return content.map((c) => c.text).join('\n');
  }

  it('reports unreferenced symbols with confidence buckets', async () => {
    const text = await callText('find_dead_code');
    expect(text).toContain('function orphan');
    expect(text).toMatch(/orphan[\s\S]*?dead \(high confidence\)/);
    expect(text).not.toMatch(/function used/);
    expect(text).not.toMatch(/function helper/); // referenced by used()
  });

  it('excludes route handlers even in a route file', async () => {
    const text = await callText('find_dead_code');
    expect(text).not.toContain('handleUsers');
  });

  it('buckets test-file helpers separately', async () => {
    const text = await callText('find_dead_code');
    expect(text).toContain('test-only files');
    expect(text).toContain('unusedTestHelper');
  });

  it('lists unused exports separately', async () => {
    const text = await callText('find_dead_code');
    // neverImported has zero references anywhere -> main dead list
    expect(text).toMatch(/function neverImported/);
    expect(text).toContain('verify before deleting');
  });
});

describe.skipIf(!GIT)('hotspots (real repo)', () => {
  let root: string;
  let store: Store;
  let client: Client;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'atlas-hot-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(root, 'src'));
    const busy = (n: number) =>
      `export function busy(): number {\n  return ${n};\n}\n` +
      Array.from({ length: 40 }, (_, i) => `export function filler${i}(): number {\n  return ${i};\n}\n`).join('');
    writeFileSync(join(root, 'src', 'busy.ts'), busy(0));
    writeFileSync(join(root, 'src', 'quiet.ts'), 'export function quiet(): number {\n  return 0;\n}\n');
    git('add', '.');
    git('commit', '-m', 'init');
    writeFileSync(join(root, 'src', 'busy.ts'), busy(1));
    git('commit', '-am', 'touch busy 1');
    writeFileSync(join(root, 'src', 'busy.ts'), busy(2));
    git('commit', '-am', 'touch busy 2');

    const config = loadConfig(root);
    store = new Store(':memory:');
    const indexer = new Indexer(config, store);
    await indexer.run();
    const server = createServer({ config, store, indexer });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  afterAll(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('ranks the frequently-touched large file first', async () => {
    const result = await client.callTool({ name: 'hotspots', arguments: {} });
    const text = (result.content as Array<{ text: string }>).map((c) => c.text).join('\n');
    expect(text).toContain('hotspots over the last 90 days (3 commits scanned):');
    const busyIdx = text.indexOf('src/busy.ts');
    const quietIdx = text.indexOf('src/quiet.ts');
    expect(busyIdx).toBeGreaterThan(-1);
    expect(text).toMatch(/src\/busy\.ts\s+3 commits/);
    if (quietIdx !== -1) expect(busyIdx).toBeLessThan(quietIdx);
  });
});
