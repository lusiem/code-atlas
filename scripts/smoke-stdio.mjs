// End-to-end smoke over real stdio: spawn the built server exactly like an MCP
// client would and exercise a few tools against this repo.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js', 'serve', '--root', '.'],
});
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return res.content.map((c) => c.text).join('\n');
};

// wait for background index to settle
for (let i = 0; i < 50; i++) {
  const status = await call('index_status');
  if (status.includes('state: ready')) break;
  await new Promise((r) => setTimeout(r, 200));
}

console.log('--- overview ---');
console.log(await call('project_overview'));
console.log('--- search Store ---');
console.log(await call('search_symbols', { query: 'searchSymbols' }));
console.log('--- outline ---');
console.log(await call('get_file_outline', { path: 'src/db/store.ts' }));
await client.close();
