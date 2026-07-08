import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-user cache root for everything code-atlas acquires at runtime:
 * language servers (servers/), the embedding runtime (embed-runtime/), and
 * embedding models (models/). Override with CODE_ATLAS_CACHE_DIR.
 */
export function cacheRoot(): string {
  if (process.env.CODE_ATLAS_CACHE_DIR) return process.env.CODE_ATLAS_CACHE_DIR;
  const base =
    process.platform === 'win32'
      ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
      : (process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'));
  return join(base, 'code-atlas');
}
