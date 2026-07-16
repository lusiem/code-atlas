import type { AppContext } from '../context.js';
import type { EdgeKind, SymbolRow } from '../types.js';

/** Edge kinds that carry "a test reaches this" upward — same set change_impact walks. */
const IMPACT_KINDS: EdgeKind[] = ['calls', 'extends', 'implements', 'overrides'];

const PER_NODE_FANIN_CAP = 200;
const VISITED_CAP = 5000;
const IMPORT_REACH_DEPTH_CAP = 4;
const IMPORT_REACH_SIZE_CAP = 2000;

export interface TestHit {
  testFile: string;
  /** Symbol in the test file that reaches the target; null for import-chain-only hits. */
  caseSymbol: SymbolRow | null;
  depth: number;
  /** Human route: `calls→name [prov conf]` or `import chain`. */
  via: string;
}

export interface TestsForResult {
  hits: TestHit[];
  truncated: boolean;
  /** Target itself lives in a test file. */
  targetIsTest: boolean;
}

/**
 * Which tests exercise this symbol? Reverse BFS from the target over incoming
 * call/type edges; every reached symbol in a test file is a direct hit. Test files
 * that only reach the target through imports (no resolved call path) are reported
 * separately as weaker, import-chain hits.
 */
export function testsForSymbol(
  ctx: AppContext,
  target: SymbolRow,
  maxDepth = 6,
  minConfidence = 0.5,
): TestsForResult {
  const files = ctx.store.listFiles();
  const testPaths = new Set(files.filter((f) => f.isTest).map((f) => f.path));
  const byId = new Map(files.map((f) => [f.id, f]));
  const targetIsTest = testPaths.has(target.path);

  // ---- call/type layer: strongest evidence, carries the test-case symbol ----
  const hitByFile = new Map<string, TestHit>();
  const visited = new Set<number>([target.id]);
  const queue: Array<{ id: number; name: string; depth: number }> = [
    { id: target.id, name: target.name, depth: 0 },
  ];
  let truncated = false;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    const edges = ctx.store.edgesFor(cur.id, 'in', IMPACT_KINDS);
    let expanded = 0;
    for (const e of edges) {
      if (e.confidence < minConfidence) continue;
      if (expanded >= PER_NODE_FANIN_CAP) {
        truncated = true;
        break;
      }
      expanded++;
      if (visited.has(e.symbolId)) continue;
      if (visited.size >= VISITED_CAP) {
        truncated = true;
        break;
      }
      visited.add(e.symbolId);
      const sym = ctx.store.getSymbolById(e.symbolId);
      if (!sym) continue;
      const depth = cur.depth + 1;
      if (testPaths.has(sym.path)) {
        const existing = hitByFile.get(sym.path);
        if (!existing || depth < existing.depth) {
          hitByFile.set(sym.path, {
            testFile: sym.path,
            caseSymbol: sym,
            depth,
            via: `${e.edgeKind}→${cur.name} [${e.provenance} ${e.confidence.toFixed(2)}]`,
          });
        }
      }
      queue.push({ id: e.symbolId, name: sym.name, depth });
    }
  }

  // ---- import layer: test files that transitively import the target's file ----
  const depthOf = new Map<number, number>();
  let frontier = new Set<number>([target.fileId]);
  for (let depth = 1; depth <= IMPORT_REACH_DEPTH_CAP && frontier.size > 0; depth++) {
    const next = new Set<number>();
    for (const id of ctx.store.filesImporting(frontier)) {
      if (id === target.fileId || depthOf.has(id)) continue;
      depthOf.set(id, depth);
      next.add(id);
      if (depthOf.size >= IMPORT_REACH_SIZE_CAP) break;
    }
    frontier = next;
  }
  for (const [fileId, depth] of depthOf) {
    const file = byId.get(fileId);
    if (!file || !file.isTest || hitByFile.has(file.path)) continue;
    hitByFile.set(file.path, {
      testFile: file.path,
      caseSymbol: null,
      depth,
      via: 'import chain',
    });
  }

  const hits = [...hitByFile.values()].sort(
    (a, b) =>
      Number(b.caseSymbol !== null) - Number(a.caseSymbol !== null) ||
      a.depth - b.depth ||
      a.testFile.localeCompare(b.testFile),
  );
  return { hits, truncated, targetIsTest };
}
