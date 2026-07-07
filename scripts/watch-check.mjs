// Live watcher check: spawn `serve` on a real repo, append a probe symbol to
// a file, and measure until the watcher has indexed + resolved it. Reverts.
// usage: node watch-check.mjs <root> <relFile> <snippetFile> <symbolName>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [root, relFile, snippetFile, symbolName] = process.argv.slice(2);
const serverEntry = resolve(import.meta.dirname, '../dist/index.js');
const target = join(root, relFile);
const original = readFileSync(target, 'utf8');
const snippet = readFileSync(snippetFile, 'utf8');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry, 'serve', '--root', root],
});
const client = new Client({ name: 'watch-check', version: '0.0.0' });
await client.connect(transport);
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return res.content.map((c) => c.text).join('\n');
};

try {
  for (let i = 0; i < 600; i++) {
    if ((await call('index_status')).includes('state: ready')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  // give chokidar a moment to finish arming on big trees
  await new Promise((r) => setTimeout(r, 3000));

  const before = await call('search_symbols', { query: symbolName });
  if (!before.startsWith('no symbols')) throw new Error(`probe already present: ${before}`);

  appendFileSync(target, snippet);
  const t0 = Date.now();
  let found = false;
  for (let i = 0; i < 240; i++) {
    const res = await call('search_symbols', { query: symbolName });
    if (!res.startsWith('no symbols')) {
      found = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(found ? `probe indexed+searchable after ${elapsed}s` : 'PROBE NEVER APPEARED');
  // wait for the batch's resolution pass to finish before reading the graph
  for (let i = 0; i < 240; i++) {
    if ((await call('index_status')).includes('state: ready')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`resolved after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('--- index_status ---');
  console.log(await call('index_status'));
  console.log('--- probe call graph (out) ---');
  console.log(await call('call_hierarchy', { name: symbolName, direction: 'out', depth: 1 }));
} finally {
  writeFileSync(target, original);
  await new Promise((r) => setTimeout(r, 1500)); // let the revert batch apply
  await client.close();
}
