// Live Godot validation against godot-demo-projects.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = 'D:/dev/mcptools/test-repos/godot-demos';
const serverEntry = 'D:/dev/mcptools/code-atlas/dist/index.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry, 'serve', '--root', root, '--no-lsp'],
});
const client = new Client({ name: 'godot-check', version: '0.0.0' });
await client.connect(transport);
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return res.content.map((c) => c.text).join('\n');
};

try {
  const t0 = Date.now();
  for (let i = 0; i < 600; i++) {
    if ((await call('index_status')).includes('state: ready')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`indexed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log('\n=== project_overview (excerpt) ===');
  const ov = await call('project_overview');
  console.log(ov.split('\n').filter((l) => l.includes('gdscript') || l.includes('godot') || l.includes('engine') || l.startsWith('totals')).join('\n'));

  console.log('\n=== get_scene_structure: pong ===');
  console.log(await call('get_scene_structure', { path: '2d/pong/pong.tscn' }));

  console.log('\n=== find_asset_references: paddle.gd ===');
  console.log(await call('find_asset_references', { target: '2d/pong/logic/paddle.gd' }));

  console.log('\n=== search_reflection: @export (first lines) ===');
  console.log((await call('search_reflection', { specifier: '@export', limit: 8 })));

  console.log('\n=== search_symbols: Player class gdscript ===');
  console.log(await call('search_symbols', { query: 'Player', lang: 'gdscript', kind: 'class', limit: 5 }));

  console.log('\n=== call_hierarchy on a gdscript fn ===');
  console.log(await call('find_references', { name: '_on_area_entered', limit: 6 }));
} finally {
  await client.close();
}
