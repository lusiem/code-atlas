// Live LSP overlay check: spawn `serve` on a repo and exercise the LSP-first
// tools against a real language server.
// usage: node scripts/lsp-check.mjs <root> <symbolName> <relFile> <needle>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [root, symbolName, relFile, needle] = process.argv.slice(2);
const serverEntry = resolve(import.meta.dirname, '../dist/index.js');

// locate the needle for go_to_definition (1-based line, 0-based col)
const source = readFileSync(join(root, relFile), 'utf8').split(/\r?\n/);
const lineIdx = source.findIndex((l) => l.includes(needle));
if (lineIdx === -1) throw new Error(`needle not found in ${relFile}: ${needle}`);
const col = source[lineIdx].indexOf(needle);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry, 'serve', '--root', root],
});
const client = new Client({ name: 'lsp-check', version: '0.0.0' });
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

  console.log(`=== find_references: ${symbolName} ===`);
  const t0 = Date.now();
  console.log(await call('find_references', { name: symbolName, limit: 15 }));
  console.log(`(took ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  console.log(`\n=== go_to_definition: ${relFile}:${lineIdx + 1}:${col} (${needle}) ===`);
  console.log(await call('go_to_definition', { path: relFile, line: lineIdx + 1, col }));

  console.log(`\n=== get_symbol_info (hover): ${symbolName} ===`);
  console.log(await call('get_symbol_info', { name: symbolName }));

  console.log(`\n=== call_hierarchy (in): ${symbolName} ===`);
  console.log(await call('call_hierarchy', { name: symbolName, direction: 'in', depth: 2 }));

  console.log('\n=== index_status ===');
  console.log(await call('index_status'));
} finally {
  await client.close();
}
