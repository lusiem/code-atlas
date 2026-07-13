import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseHunkRanges, uncommittedChanges } from '../src/git/diff.js';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GIT = hasGit();

describe('parseHunkRanges', () => {
  it('reads new-side ranges from unified-diff headers', () => {
    const diff = [
      '@@ -10,3 +12,5 @@ function foo() {',
      ' context',
      '@@ -20 +30 @@',
      '@@ -40,2 +45,0 @@', // pure deletion
    ].join('\n');
    expect(parseHunkRanges(diff)).toEqual([
      { start: 12, count: 5 },
      { start: 30, count: 1 },
      { start: 45, count: 0 },
    ]);
  });

  it('ignores non-header lines that mention @@', () => {
    expect(parseHunkRanges('some text @@ -1 +1 @@ inline')).toEqual([]);
  });
});

describe.skipIf(!GIT)('uncommittedChanges (real repo)', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'atlas-git-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
    writeFileSync(join(root, 'gone.ts'), 'export const gone = 1;\n');
    git('add', '.');
    git('commit', '-m', 'init');
    // one modified, one deleted, one untracked
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\nexport const b = 22;\nexport const c = 3;\n');
    rmSync(join(root, 'gone.ts'));
    writeFileSync(join(root, 'new.ts'), 'export const fresh = 1;\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports modified files with hunk ranges', async () => {
    const res = await uncommittedChanges(root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const modified = res.changes.find((c) => c.path === 'a.ts');
    expect(modified?.status).toBe('modified');
    expect(modified?.hunks).toEqual([{ start: 2, count: 1 }]);
  });

  it('reports deletions and untracked files', async () => {
    const res = await uncommittedChanges(root);
    if (!res.ok) throw new Error(res.reason);
    expect(res.changes.find((c) => c.path === 'gone.ts')?.status).toBe('deleted');
    expect(res.changes.find((c) => c.path === 'new.ts')?.status).toBe('untracked');
  });
});

describe('uncommittedChanges (no repo)', () => {
  it('fails soft outside a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-norepo-'));
    try {
      const res = await uncommittedChanges(dir);
      // either git is missing or the dir is not a repo — both must be soft
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
