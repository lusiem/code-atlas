// Real-repo shakedown: spawn the built server against an arbitrary repo root,
// wait for the index, then exercise the flow tools on the symbols the index
// itself says are most-called. Usage: node scripts/validate-repo.mjs <repoRoot>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const serverEntry = resolve(import.meta.dirname, '../dist/index.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry, 'serve', '--root', root],
});
const client = new Client({ name: 'validate', version: '0.0.0' });
await client.connect(transport);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return res.content.map((c) => c.text).join('\n');
};

// wait for background index to settle (large repos take a while)
let status = '';
for (let i = 0; i < 900; i++) {
  status = await call('index_status');
  if (status.includes('state: ready')) break;
  await new Promise((r) => setTimeout(r, 1000));
}

console.log('=== index_status ===');
console.log(status);
console.log('\n=== project_overview ===');
console.log(await call('project_overview'));

// Peek at the index DB to pick interesting symbols: most incoming call edges.
const db = new Database(join(root, '.code-atlas', 'index.db'), { readonly: true });
const hot = db
  .prepare(
    `SELECT s.id, s.name, s.kind, f.path, COUNT(*) AS callers
     FROM edges e JOIN symbols s ON s.id = e.dst_symbol_id
     JOIN files f ON f.id = s.file_id
     WHERE e.kind = 'calls'
     GROUP BY e.dst_symbol_id ORDER BY callers DESC LIMIT 5`,
  )
  .all();
const biggestFile = db
  .prepare(
    `SELECT f.path, COUNT(*) AS syms FROM symbols s JOIN files f ON f.id = s.file_id
     GROUP BY s.file_id ORDER BY syms DESC LIMIT 1`,
  )
  .get();
const unresolvedPct = db
  .prepare(
    `SELECT ROUND(100.0 * SUM(resolved_symbol_id IS NULL) / COUNT(*), 1) AS pct
     FROM occurrences WHERE role = 'call'`,
  )
  .get();
db.close();

console.log(`\nunresolved call occurrences: ${unresolvedPct.pct}%`);
console.log('\n=== hottest call targets ===');
for (const h of hot) console.log(`  #${h.id} ${h.kind} ${h.name} (${h.path}) — ${h.callers} callers`);

if (hot.length > 0) {
  const top = hot[0];
  console.log(`\n=== find_references: ${top.name} ===`);
  console.log(await call('find_references', { symbol_id: top.id, limit: 10 }));
  console.log(`\n=== call_hierarchy (in): ${top.name} ===`);
  console.log(await call('call_hierarchy', { symbol_id: top.id, direction: 'in', depth: 2 }));
}
if (biggestFile) {
  console.log(`\n=== get_file_outline: ${biggestFile.path} (${biggestFile.syms} symbols) ===`);
  const outline = await call('get_file_outline', { path: biggestFile.path });
  console.log(outline.split('\n').slice(0, 40).join('\n'));
}
await client.close();
