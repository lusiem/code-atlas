import type { AtlasConfig } from './config.js';
import type { Store } from './db/store.js';
import type { Embedder } from './embeddings/embedder.js';
import type { Indexer } from './indexer/indexer.js';
import type { Watcher } from './indexer/watcher.js';
import type { LspManager } from './lsp/manager.js';

/** Shared state handed to every tool handler. */
export interface AppContext {
  config: AtlasConfig;
  store: Store;
  indexer: Indexer;
  /** Present while serving with watch enabled. */
  watcher?: Watcher;
  /** Present while serving; tools fall back to the index when absent. */
  lsp?: LspManager;
  /** Present while serving; semantic_search degrades to keyword-only when absent. */
  embedder?: Embedder;
}
