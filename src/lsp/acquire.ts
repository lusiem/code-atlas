import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { LaunchSpec } from './client.js';
import type { ServerSpec } from './registry.js';

/** Per-user cache for auto-acquired language servers. */
export function defaultCacheDir(): string {
  if (process.env.CODE_ATLAS_CACHE_DIR) return process.env.CODE_ATLAS_CACHE_DIR;
  const base =
    process.platform === 'win32'
      ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
      : (process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'));
  return join(base, 'code-atlas', 'servers');
}

const WIN_EXTS = ['.exe', '.cmd', '.bat', ''];

/** Locate an executable on PATH (Windows extension probing included). */
export function findOnPath(names: string[]): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? WIN_EXTS : [''];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = join(dir, name + ext);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    const viaCmd = process.platform === 'win32' && !/\.exe$/i.test(command);
    const child = viaCmd
      ? spawn('cmd.exe', ['/c', command, ...args], { env, stdio: 'ignore' })
      : spawn(command, args, { env, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/**
 * Resolve a launchable server: PATH first, then the managed cache,
 * downloading into it when allowed. Null = structural-only for this server.
 */
export async function ensureServer(
  spec: ServerSpec,
  opts: { download: boolean; cacheDir: string },
): Promise<LaunchSpec | null> {
  const onPath = findOnPath(spec.detectNames);
  if (onPath) return { command: onPath, args: spec.pathArgs };

  const acquire = spec.acquire;
  if (!acquire) return null;

  if (acquire.kind === 'npm') {
    const installDir = join(opts.cacheDir, spec.id);
    const entry = join(installDir, 'node_modules', ...acquire.entry.split('/'));
    if (!existsSync(entry)) {
      if (!opts.download) return null;
      mkdirSync(installDir, { recursive: true });
      const ok = await run('npm', [
        'install',
        '--prefix', installDir,
        '--no-audit', '--no-fund', '--loglevel=error',
        ...acquire.packages,
      ]);
      if (!ok || !existsSync(entry)) return null;
    }
    return {
      command: process.execPath,
      args: [entry, ...acquire.args],
      initializationOptions: acquire.initOptions?.(installDir),
    };
  }

  // acquire.kind === 'go'
  const binDir = join(opts.cacheDir, 'bin');
  const bin = join(binDir, acquire.bin + (process.platform === 'win32' ? '.exe' : ''));
  if (!existsSync(bin)) {
    if (!opts.download || !findOnPath(['go'])) return null;
    mkdirSync(binDir, { recursive: true });
    const ok = await run('go', ['install', acquire.module], { ...process.env, GOBIN: binDir });
    if (!ok || !existsSync(bin)) return null;
  }
  return { command: bin, args: acquire.args };
}
