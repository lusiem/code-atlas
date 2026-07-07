import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { Indexer } from '../src/indexer/indexer.js';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ts-sample');
const PY_FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'py-sample');

let store: Store;

beforeAll(async () => {
  const config = loadConfig(FIXTURE_ROOT);
  store = new Store(':memory:');
  const indexer = new Indexer(config, store);
  await indexer.run();
});

afterAll(() => {
  store?.close();
  rmSync(join(FIXTURE_ROOT, '.code-atlas'), { recursive: true, force: true });
});

function symbolId(name: string, kind?: string): number {
  const rows = store.searchSymbols(name, { limit: 50, offset: 0 });
  const hit = rows.find((r) => r.name === name && (!kind || r.kind === kind));
  if (!hit) throw new Error(`fixture symbol not found: ${name}`);
  return hit.id;
}

describe('resolver', () => {
  it('resolves relative TS imports to files', () => {
    const math = store.getFileByPath('src/math.ts')!;
    const calc = store.getFileByPath('src/calculator.ts')!;
    const deps = store.dependenciesOf(calc.id);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.resolvedPath).toBe('src/math.ts');

    const mathDeps = store.dependenciesOf(math.id);
    expect(mathDeps.map((d) => d.resolvedPath).sort()).toEqual(['src/config.ts', 'src/logger.ts']);
  });

  it('reports dependents (reverse imports)', () => {
    const math = store.getFileByPath('src/math.ts')!;
    const dependents = store.dependentsOf(math.id);
    expect(dependents.map((d) => d.path)).toEqual(['src/calculator.ts']);
  });

  it('resolves cross-file call occurrences to imported symbols', () => {
    const addId = symbolId('add', 'function');
    const refs = store.referencesTo(addId, 'add', 50, 0);
    const resolved = refs.filter((r) => r.resolvedSymbolId === addId);
    expect(resolved.some((r) => r.path === 'src/calculator.ts' && r.role === 'call')).toBe(true);
    // explicit import binding -> high confidence
    const call = resolved.find((r) => r.role === 'call')!;
    expect(call.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('builds call edges with enclosing symbols as sources', () => {
    const calculateId = symbolId('calculate', 'function');
    const out = store.edgesFor(calculateId, 'out', ['calls']);
    const names = out.map((e) => e.name);
    expect(names).toContain('add');
    expect(names).toContain('multiply');
    expect(names).toContain('area');

    const incoming = store.edgesFor(calculateId, 'in', ['calls']);
    expect(incoming.map((e) => e.name)).toContain('report');
  });

  it('builds implements edges from declared bases', () => {
    const circleId = symbolId('Circle', 'class');
    const shapeId = symbolId('Shape', 'interface');
    const out = store.edgesFor(circleId, 'out', ['extends', 'implements']);
    expect(out.some((e) => e.symbolId === shapeId && e.edgeKind === 'implements')).toBe(true);
    const subs = store.edgesFor(shapeId, 'in', ['extends', 'implements']);
    expect(subs.some((e) => e.symbolId === circleId)).toBe(true);
  });

  it('records resolve stats in occurrences', () => {
    const stats = store.stats();
    expect(stats.occurrences).toBeGreaterThan(0);
    expect(stats.edges).toBeGreaterThan(0);
  });
});

describe('resolver: ubiquitous names', () => {
  let pyStore: Store;

  beforeAll(async () => {
    const config = loadConfig(PY_FIXTURE_ROOT);
    pyStore = new Store(':memory:');
    const indexer = new Indexer(config, pyStore);
    await indexer.run();
  });

  afterAll(() => {
    pyStore?.close();
    rmSync(join(PY_FIXTURE_ROOT, '.code-atlas'), { recursive: true, force: true });
  });

  it('does not attract builtin calls from other files (django `super` case)', () => {
    const rows = pyStore.searchSymbols('super', { limit: 10, offset: 0 });
    const superMethod = rows.find((r) => r.name === 'super' && r.kind === 'method')!;
    expect(superMethod).toBeDefined();
    const incoming = pyStore.edgesFor(superMethod.id, 'in', ['calls']);
    // pkg/child.py calls builtin super() — that must NOT create an edge here
    expect(incoming.map((e) => e.path)).toEqual(['pkg/nodes.py']);
  });

  it('still resolves ubiquitous names within the defining file', () => {
    const rows = pyStore.searchSymbols('super', { limit: 10, offset: 0 });
    const superMethod = rows.find((r) => r.name === 'super' && r.kind === 'method')!;
    const incoming = pyStore.edgesFor(superMethod.id, 'in', ['calls']);
    expect(incoming.some((e) => e.name === 'render')).toBe(true);
    expect(incoming[0]!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('still resolves non-ubiquitous names across files via imports', () => {
    const rows = pyStore.searchSymbols('render', { limit: 10, offset: 0 });
    const render = rows.find((r) => r.name === 'render' && r.kind === 'method')!;
    const incoming = pyStore.edgesFor(render.id, 'in', ['calls']);
    expect(incoming.some((e) => e.path === 'pkg/child.py')).toBe(true);
  });
});
