// Live semantic_search check: spawn `serve` on a repo, trigger the lazy
// model acquisition with a first query, wait for full embedding coverage,
// then run real hybrid queries.
// usage: node scripts/embed-check.mjs <root> <query> [query2 ...]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

const [root, ...queries] = process.argv.slice(2);
const serverEntry = resolve(import.meta.dirname, '../dist/index.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry, 'serve', '--root', root],
  stderr: 'inherit',
});
const client = new Client({ name: 'embed-check', version: '0.0.0' });
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

  console.log(`=== first semantic_search (may trigger one-time downloads) ===`);
  const t0 = Date.now();
  console.log(await call('semantic_search', { query: queries[0], k: 5 }));
  console.log(`(returned in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  console.log('\n=== waiting for full embedding coverage ===');
  let status = '';
  for (let i = 0; i < 2400; i++) {
    status = (await call('index_status')).split('\n').find((l) => l.startsWith('embeddings:')) ?? '';
    const m = status.match(/(\d+)\/(\d+) chunks embedded/);
    if (m && m[1] === m[2] && Number(m[2]) > 0 && !/downloading|loading|backlog/.test(status)) break;
    if (i % 20 === 0) console.log(`  ${status}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`  ${status}`);

  for (const q of queries) {
    console.log(`\n=== semantic_search: "${q}" ===`);
    const t = Date.now();
    console.log(await call('semantic_search', { query: q, k: 5 }));
    console.log(`(took ${((Date.now() - t) / 1000).toFixed(2)}s)`);
  }
} finally {
  await client.close();
}
