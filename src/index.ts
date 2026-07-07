#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { Store } from './db/store.js';
import { Indexer } from './indexer/indexer.js';
import { Watcher } from './indexer/watcher.js';
import { createServer } from './server.js';

function parseArgs(argv: string[]): { command: string; root: string; watch: boolean } {
  let command = 'serve';
  let root = process.cwd();
  let watch = true;
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) command = args.shift()!;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = args[++i]!;
    else if (args[i] === '--no-watch') watch = false;
  }
  return { command, root, watch };
}

async function main(): Promise<void> {
  const { command, root, watch } = parseArgs(process.argv.slice(2));
  const config = loadConfig(root);
  if (!watch) config.watch = false;
  const store = new Store(config.dbPath);
  const indexer = new Indexer(config, store);
  const ctx: AppContext = { config, store, indexer };

  if (command === 'index') {
    // one-shot CLI indexing (debugging / warm-up)
    await indexer.run();
    const stats = store.stats();
    console.log(
      `indexed ${stats.files} files, ${stats.symbols} symbols, ${stats.imports} imports` +
        (indexer.progress.errors.length ? `, ${indexer.progress.errors.length} errors` : ''),
    );
    for (const e of indexer.progress.errors.slice(0, 10)) console.error(`  ${e.path}: ${e.message}`);
    store.close();
    return;
  }

  if (command !== 'serve') {
    console.error(`unknown command: ${command} (expected "serve" or "index")`);
    process.exit(1);
  }

  // stdout is the JSON-RPC channel — all logging goes to stderr
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // the watcher keeps the event loop alive, so exit explicitly when the
  // client goes away (stdin closes) instead of lingering as an orphan
  process.stdin.on('close', () => {
    void (async () => {
      await ctx.watcher?.stop();
      store.close();
      process.exit(0);
    })();
  });
  console.error(`[code-atlas] serving ${config.root}`);
  // index in the background; tools work (on stale data) meanwhile
  void indexer.run().then(() => {
    const stats = store.stats();
    console.error(`[code-atlas] index ready: ${stats.files} files, ${stats.symbols} symbols`);
    if (config.watch) {
      ctx.watcher = new Watcher(config, indexer);
      ctx.watcher.start();
      console.error('[code-atlas] watching for changes');
    }
  });
}

main().catch((err) => {
  console.error('[code-atlas] fatal:', err);
  process.exit(1);
});
