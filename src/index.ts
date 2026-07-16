#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { Store } from './db/store.js';
import { Embedder } from './embeddings/embedder.js';
import { Indexer } from './indexer/indexer.js';
import { Watcher } from './indexer/watcher.js';
import { LspManager } from './lsp/manager.js';
import { promoteEdges } from './lsp/promote.js';
import { createServer } from './server.js';

function parseArgs(argv: string[]): {
  command: string;
  root: string;
  watch: boolean;
  lsp: boolean;
  download: boolean;
  embeddings: boolean;
} {
  let command = 'serve';
  let root = process.cwd();
  let watch = true;
  let lsp = true;
  let download = true;
  let embeddings = true;
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) command = args.shift()!;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = args[++i]!;
    else if (args[i] === '--no-watch') watch = false;
    else if (args[i] === '--no-lsp') lsp = false;
    else if (args[i] === '--no-download') download = false;
    else if (args[i] === '--no-embeddings') embeddings = false;
  }
  return { command, root, watch, lsp, download, embeddings };
}

async function main(): Promise<void> {
  const { command, root, watch, lsp, download, embeddings } = parseArgs(process.argv.slice(2));
  const config = loadConfig(root);
  if (!watch) config.watch = false;
  if (!lsp) config.lsp.enabled = false;
  if (!embeddings) config.embeddings.enabled = false;
  if (!download) {
    config.lsp.download = false;
    config.embeddings.download = false;
  }
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

  ctx.lsp = new LspManager(config.root, config.lsp);
  ctx.embedder = new Embedder(store, config.embeddings);

  // stdout is the JSON-RPC channel — all logging goes to stderr
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // the watcher keeps the event loop alive, so exit explicitly when the
  // client goes away (stdin closes) instead of lingering as an orphan
  process.stdin.on('close', () => {
    void (async () => {
      await ctx.watcher?.stop();
      await ctx.lsp?.shutdown();
      await ctx.embedder?.shutdown();
      store.close();
      process.exit(0);
    })();
  });
  console.error(`[code-atlas] serving ${config.root}`);
  // index in the background; tools work (on stale data) meanwhile
  void indexer.run().then(() => {
    const stats = store.stats();
    console.error(`[code-atlas] index ready: ${stats.files} files, ${stats.symbols} symbols`);
    // resumes embedding only when the model is already cached locally;
    // the first-ever download waits for an explicit semantic_search
    ctx.embedder?.activate('startup');
    if (config.watch) {
      ctx.watcher = new Watcher(config, indexer, {
        onBatch: (paths) => {
          ctx.lsp?.filesChanged(paths);
          ctx.embedder?.nudge();
        },
      });
      ctx.watcher.start();
      console.error('[code-atlas] watching for changes');
    }
    if (config.lsp.enabled && config.lsp.promoteEdges) {
      // opt-in: verify low-confidence call edges against servers that other
      // tool calls have already started; budgeted, cursor-resumed
      let promoting = false;
      const tick = async (): Promise<void> => {
        if (promoting || indexer.progress.state === 'indexing') return;
        promoting = true;
        try {
          const s = await promoteEdges(ctx);
          if (s.examined > 0) {
            console.error(
              `[code-atlas] lsp edge promotion: ${s.confirmed} confirmed, ${s.corrected} corrected, ${s.unverified} unverified`,
            );
          }
        } finally {
          promoting = false;
        }
      };
      setTimeout(() => void tick(), 30_000).unref();
      setInterval(() => void tick(), 10 * 60_000).unref();
    }
  });
}

main().catch((err) => {
  console.error('[code-atlas] fatal:', err);
  process.exit(1);
});
