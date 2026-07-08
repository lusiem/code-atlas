// Performance benchmark: cold-index a repo, then measure warm tool-call
// latencies through a real in-process MCP round-trip.
// usage: node scripts/bench.mjs <root> [--assert]
//   --assert: exit 1 when a loose regression bound is exceeded (CI mode;
//   bounds are deliberately generous for shared runners)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { Store } from '../dist/db/store.js';
import { Indexer } from '../dist/indexer/indexer.js';
import { createServer } from '../dist/server.js';

const args = process.argv.slice(2);
const assertMode = args.includes('--assert');
const root = resolve(args.find((a) => !a.startsWith('--')) ?? '.');

const COLD_INDEX_BOUND_S = 180;
const QUERY_P95_BOUND_MS = 500;
const ITERATIONS = 30;

const config = loadConfig(root);
config.embeddings.enabled = false; // structural benchmark; embedding is background work
const store = new Store(':memory:');
const indexer = new Indexer(config, store);

const t0 = performance.now();
await indexer.run();
const coldS = (performance.now() - t0) / 1000;

const stats = store.stats();
let loc = 0;
for (const f of store.listFiles()) {
  try {
    loc += readFileSync(join(config.root, f.path), 'utf8').split('\n').length;
  } catch {
    // deleted mid-run: ignore
  }
}
console.log(`cold index: ${coldS.toFixed(1)}s — ${stats.files} files, ${(loc / 1000).toFixed(0)}k LOC, ` +
  `${stats.symbols} symbols, ${stats.edges} edges (${(loc / 1000 / coldS).toFixed(0)}k LOC/s)`);

// pick real workload inputs from the indexed data
const files = store.listFiles();
const biggestFile = files
  .map((f) => ({ f, n: store.symbolsForFile(f.id).length }))
  .sort((a, b) => b.n - a.n)[0].f;
const hotSymbol = store.db
  .prepare(
    `SELECT s.name FROM occurrences o JOIN symbols s ON s.id = o.resolved_symbol_id
     GROUP BY o.resolved_symbol_id ORDER BY COUNT(*) DESC LIMIT 1`,
  )
  .get().name;

const server = createServer({ config, store, indexer });
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'bench', version: '0.0.0' });
await Promise.all([server.connect(st), client.connect(ct)]);

const workloads = [
  ['search_symbols', { query: hotSymbol.slice(0, Math.max(3, hotSymbol.length - 2)), limit: 20 }],
  ['get_file_outline', { path: biggestFile.path }],
  ['get_symbol_info', { name: hotSymbol }],
  ['find_references', { name: hotSymbol, limit: 50 }],
  ['call_hierarchy', { name: hotSymbol, direction: 'in', depth: 2 }],
  ['get_dependencies', { path: biggestFile.path }],
];

let worstP95 = 0;
for (const [tool, toolArgs] of workloads) {
  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t = performance.now();
    await client.callTool({ name: tool, arguments: toolArgs });
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(ITERATIONS * 0.5)];
  const p95 = times[Math.floor(ITERATIONS * 0.95)];
  worstP95 = Math.max(worstP95, p95);
  console.log(`${tool.padEnd(18)} p50 ${p50.toFixed(1).padStart(7)} ms   p95 ${p95.toFixed(1).padStart(7)} ms`);
}

await client.close();
store.close();

if (assertMode) {
  const failures = [];
  if (coldS > COLD_INDEX_BOUND_S) failures.push(`cold index ${coldS.toFixed(1)}s > ${COLD_INDEX_BOUND_S}s`);
  if (worstP95 > QUERY_P95_BOUND_MS) failures.push(`worst query p95 ${worstP95.toFixed(1)}ms > ${QUERY_P95_BOUND_MS}ms`);
  if (failures.length > 0) {
    console.error(`BENCH REGRESSION: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('BENCH OK (within bounds)');
}
