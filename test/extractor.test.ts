import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractFile } from '../src/parsing/extractor.js';
import { typescriptExtractor } from '../src/parsing/langs/ecmascript.js';
import { pythonExtractor } from '../src/parsing/langs/python.js';
import type { ExtractedSymbol, FileExtraction } from '../src/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function load(rel: string): string {
  return readFileSync(join(FIXTURES, rel), 'utf8');
}

function index(result: FileExtraction): Map<string, ExtractedSymbol> {
  return new Map(result.symbols.map((s) => [s.name, s]));
}

describe('typescript extractor', () => {
  const resultP = extractFile(typescriptExtractor, load('ts-sample/src/math.ts'));

  it('extracts functions with docs and export flag', async () => {
    const byName = index(await resultP);
    const add = byName.get('add')!;
    expect(add.kind).toBe('function');
    expect(add.isExported).toBe(true);
    expect(add.docComment).toBe('Adds two numbers.');
    expect(add.signature).toContain('add(a: number, b: number): number');
    expect(add.startLine).toBe(5);
  });

  it('classifies arrow-function consts as functions with line-comment docs', async () => {
    const byName = index(await resultP);
    const multiply = byName.get('multiply')!;
    expect(multiply.kind).toBe('function');
    expect(multiply.isExported).toBe(true);
    expect(multiply.docComment).toContain('Multiplies two numbers.');
    expect(multiply.docComment).toContain('Used by the calculator.');
  });

  it('extracts non-exported top-level variables', async () => {
    const byName = index(await resultP);
    const factor = byName.get('INTERNAL_FACTOR')!;
    expect(factor.kind).toBe('variable');
    expect(factor.isExported).toBe(false);
  });

  it('extracts interfaces, classes, enums, type aliases, namespaces', async () => {
    const byName = index(await resultP);
    expect(byName.get('Shape')!.kind).toBe('interface');
    expect(byName.get('Circle')!.kind).toBe('class');
    expect(byName.get('Color')!.kind).toBe('enum');
    expect(byName.get('Point')!.kind).toBe('type_alias');
    expect(byName.get('Geometry')!.kind).toBe('namespace');
  });

  it('nests members under containers with correct kinds', async () => {
    const result = await resultP;
    const byName = index(result);

    // `area` exists as an interface method signature and a class method
    const areas = result.symbols.filter((s) => s.name === 'area' && s.kind === 'method');
    const parents = areas.map((s) => result.symbols[s.parentIndex!]!.name).sort();
    expect(parents).toEqual(['Circle', 'Shape']);

    expect(byName.get('constructor')!.kind).toBe('constructor');

    const red = byName.get('Red')!;
    expect(red.kind).toBe('enum_member');
    expect(result.symbols[red.parentIndex!]!.name).toBe('Color');
    expect(byName.get('Green')!.kind).toBe('enum_member');

    const distance = byName.get('distance')!;
    expect(result.symbols[distance.parentIndex!]!.name).toBe('Geometry');
  });

  it('extracts imports with bound names', async () => {
    const result = await resultP;
    expect(result.imports).toEqual([
      { specifier: './logger', names: ['logger'], startLine: 1 },
      { specifier: './config', names: ['Config'], startLine: 2 },
    ]);
  });
});

describe('python extractor', () => {
  const resultP = extractFile(pythonExtractor, load('py-sample/app.py'));

  it('extracts functions and classes with docstrings', async () => {
    const byName = index(await resultP);
    const fetch = byName.get('fetch')!;
    expect(fetch.kind).toBe('function');
    expect(fetch.docComment).toBe('Fetch a URL with retries.');

    const repo = byName.get('Repository')!;
    expect(repo.kind).toBe('class');
    expect(repo.docComment).toBe('A repository of things.');
  });

  it('classifies methods, constructors, and privacy', async () => {
    const result = await resultP;
    const byName = index(result);

    expect(byName.get('__init__')!.kind).toBe('constructor');

    const clone = byName.get('clone')!;
    expect(clone.kind).toBe('method');
    expect(result.symbols[clone.parentIndex!]!.name).toBe('Repository');

    expect(byName.get('_private_helper')!.isExported).toBe(false);
    expect(clone.isExported).toBe(true);
  });

  it('extracts module vars and class fields', async () => {
    const result = await resultP;
    const byName = index(result);
    expect(byName.get('MAX_RETRIES')!.kind).toBe('variable');
    expect(byName.get('_internal_cache')!.isExported).toBe(false);
    const branch = byName.get('default_branch')!;
    expect(branch.kind).toBe('field');
    expect(result.symbols[branch.parentIndex!]!.name).toBe('Repository');
  });

  it('extracts plain, aliased, from- and nested imports', async () => {
    const result = await resultP;
    expect(result.imports).toContainEqual({ specifier: 'os', names: ['os'], startLine: 3 });
    expect(result.imports).toContainEqual({ specifier: 'os.path', names: ['osp'], startLine: 4 });
    expect(result.imports).toContainEqual({
      specifier: 'collections',
      names: ['OrderedDict', 'defaultdict'],
      startLine: 5,
    });
    expect(result.imports.some((i) => i.specifier === 'json')).toBe(true);
  });
});
