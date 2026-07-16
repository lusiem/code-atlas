import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { Indexer } from '../src/indexer/indexer.js';
import { verifyChanges } from '../src/analysis/verify.js';
import type { AppContext } from '../src/context.js';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GIT = hasGit();

const MATH_SRC =
  'export function add(a: number, b: number): number {\n  return a + b;\n}\n' +
  'export function unloved(): number {\n  return 0;\n}\n';
const CALC_SRC =
  "import { add } from './math.js';\n" +
  'export function calculate(): number {\n  return add(1, 2);\n}\n';

describe.skipIf(!GIT)('verifyChanges (real repo)', () => {
  let root: string;
  let store: Store;
  let ctx: AppContext;
  let git: (...args: string[]) => void;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'atlas-verify-'));
    git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'math.ts'), MATH_SRC);
    writeFileSync(join(root, 'src', 'calc.ts'), CALC_SRC);
    git('add', '.');
    git('commit', '-m', 'init');

    const config = loadConfig(root);
    store = new Store(':memory:');
    const indexer = new Indexer(config, store);
    await indexer.run();
    ctx = { config, store, indexer };
  });

  beforeEach(async () => {
    git('checkout', '--', '.');
    git('clean', '-fdq');
    await ctx.indexer.run();
  });

  afterAll(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a clean tree as nothing to verify', async () => {
    const result = await verifyChanges(ctx);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('clean');
  });

  it('flags a new import that resolves nowhere', async () => {
    writeFileSync(
      join(root, 'src', 'calc.ts'),
      "import { add } from './missing.js';\n" +
        'export function calculate(): number {\n  return add(1, 2);\n}\n',
    );
    const result = await verifyChanges(ctx);
    if ('error' in result) throw new Error(result.error);
    const broken = result.findings.filter((f) => f.severity === 'BROKEN');
    expect(broken.some((f) => f.message.includes('"./missing.js" does not resolve'))).toBe(true);
  });

  it('flags a removed export that other files still reference', async () => {
    writeFileSync(
      join(root, 'src', 'math.ts'),
      'export function unloved(): number {\n  return 0;\n}\n',
    );
    const result = await verifyChanges(ctx);
    if ('error' in result) throw new Error(result.error);
    const broken = result.findings.filter((f) => f.severity === 'BROKEN');
    expect(broken.some((f) => f.message.includes('function add was removed'))).toBe(true);
    expect(broken.some((f) => f.message.includes('src/calc.ts'))).toBe(true);
  });

  it('reports a signature change with its callers as CHECK, not BROKEN', async () => {
    writeFileSync(
      join(root, 'src', 'math.ts'),
      'export function add(a: number, b: number, c: number): number {\n  return a + b + c;\n}\n' +
        'export function unloved(): number {\n  return 0;\n}\n',
    );
    const result = await verifyChanges(ctx);
    if ('error' in result) throw new Error(result.error);
    const check = result.findings.filter((f) => f.severity === 'CHECK');
    expect(check.some((f) => f.message.includes('signature of function add changed'))).toBe(true);
    expect(check.some((f) => f.message.includes('calculate'))).toBe(true);
    expect(result.findings.filter((f) => f.severity === 'BROKEN').length).toBe(0);
  });

  it('treats a removed export with no references as informational', async () => {
    writeFileSync(
      join(root, 'src', 'math.ts'),
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    );
    const result = await verifyChanges(ctx);
    if ('error' in result) throw new Error(result.error);
    expect(result.findings.filter((f) => f.severity === 'BROKEN').length).toBe(0);
    const info = result.findings.filter((f) => f.severity === 'INFO');
    expect(info.some((f) => f.message.includes('unloved removed — no remaining references'))).toBe(true);
  });
});
