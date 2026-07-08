import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { scanWorkspace } from '../src/indexer/scanner.js';

const root = mkdtempSync(join(tmpdir(), 'atlas-scan-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function put(rel: string, content = '// x\n'): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

describe('scanWorkspace', () => {
  it('finds source files, honors nested .gitignore and defaults', () => {
    put('keep.ts');
    put('README.md'); // not a source language
    put('node_modules/dep/index.js'); // default-ignored
    put('.gitignore', 'ignored-dir/\n*.gen.ts\n');
    put('ignored-dir/hidden.ts');
    put('api.gen.ts');
    put('nested/kept.py', 'x = 1\n');
    put('nested/.gitignore', 'local.ts\n');
    put('nested/local.ts');
    put('nested/deeper/local.ts'); // nested gitignore applies to subdirs too

    put('game/level.tscn', '[gd_scene]\n');
    put('game/project.godot', 'config_version=5\n');

    const { files, assets } = scanWorkspace(loadConfig(root));
    const paths = files.map((f) => f.relPath);

    expect(paths).toContain('keep.ts');
    expect(paths).toContain('nested/kept.py');
    expect(paths).not.toContain('node_modules/dep/index.js');
    expect(paths).not.toContain('ignored-dir/hidden.ts');
    expect(paths).not.toContain('api.gen.ts');
    expect(paths).not.toContain('nested/local.ts');
    expect(paths).not.toContain('nested/deeper/local.ts');

    // engine assets are discovered separately from source files
    expect(paths).not.toContain('game/level.tscn');
    const assetPaths = assets.map((a) => a.relPath);
    expect(assetPaths).toContain('game/level.tscn');
    expect(assetPaths).toContain('game/project.godot');
    expect(assets.find((a) => a.relPath === 'game/level.tscn')!.info).toEqual({
      kind: 'scene',
      engine: 'godot',
    });
  });

  it('applies config excludes and detects languages', () => {
    put('skipme/tool.ts');
    const config = { ...loadConfig(root), exclude: ['skipme/'] };
    const { files } = scanWorkspace(config);
    expect(files.map((f) => f.relPath)).not.toContain('skipme/tool.ts');

    const py = files.find((f) => f.relPath === 'nested/kept.py')!;
    expect(py.lang).toBe('python');
  });
});
