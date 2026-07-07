import type { AtlasConfig } from './config.js';
import type { Store } from './db/store.js';
import type { Indexer } from './indexer/indexer.js';
import type { Watcher } from './indexer/watcher.js';

/** Shared state handed to every tool handler. */
export interface AppContext {
  config: AtlasConfig;
  store: Store;
  indexer: Indexer;
  /** Present while serving with watch enabled. */
  watcher?: Watcher;
}
