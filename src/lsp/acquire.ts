import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import * as tarPkg from 'tar';
import { cacheRoot } from '../cache.js';
import type { LaunchSpec } from './client.js';
import type { BinaryAsset, PlatformKey, ServerSpec } from './registry.js';

/** Per-user cache for auto-acquired language servers. */
export function defaultCacheDir(): string {
  return join(cacheRoot(), 'servers');
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

/** Run a command to completion, false on spawn failure or nonzero exit. */
export function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    const viaCmd = process.platform === 'win32' && !/\.exe$/i.test(command);
    const child = viaCmd
      ? spawn('cmd.exe', ['/c', command, ...args], { env, stdio: 'ignore' })
      : spawn(command, args, { env, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

// ---------- runtime detection ----------

/** java from JAVA_HOME or PATH. */
export function findJava(): string | null {
  if (process.env.JAVA_HOME) {
    const cand = join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (existsSync(cand)) return cand;
  }
  return findOnPath(['java']);
}

/** Major version of a java executable (`java -version` prints to stderr). */
export function javaMajor(javaCmd: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(javaCmd, ['-version'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', () => resolve(null));
    child.on('exit', () => {
      const m = /version "(\d+)(?:\.(\d+))?/.exec(err);
      if (!m) return resolve(null);
      const major = Number(m[1]);
      resolve(major === 1 ? Number(m[2] ?? 0) : major); // "1.8.0" -> 8
    });
  });
}

export function findDotnet(): string | null {
  return findOnPath(['dotnet']);
}

// ---------- pinned downloads ----------

function platformKey(): PlatformKey {
  return `${process.platform}-${process.arch}` as PlatformKey;
}

async function downloadVerified(url: string, sha256: string): Promise<Buffer | null> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== sha256) {
    console.error(`[code-atlas] CHECKSUM MISMATCH for ${url}: expected ${sha256}, got ${actual}`);
    return null;
  }
  return buf;
}

async function extractTo(buf: Buffer, archive: BinaryAsset['archive'], destDir: string, gzBin?: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  if (archive === 'zip') {
    new AdmZip(buf).extractAllTo(destDir, true);
  } else if (archive === 'gz') {
    // single gzipped executable
    const out = join(destDir, gzBin ?? 'binary');
    writeFileSync(out, gunzipSync(buf));
    if (process.platform !== 'win32') chmodSync(out, 0o755);
  } else {
    const tmp = join(destDir, '.download.tar.gz');
    writeFileSync(tmp, buf);
    await tarPkg.extract({ file: tmp, cwd: destDir });
    rmSync(tmp, { force: true });
  }
}

/** Download+verify+extract a pinned asset once; returns the executable path. */
async function ensureBinary(
  installDir: string,
  asset: BinaryAsset,
  download: boolean,
): Promise<string | null> {
  const binRel = (process.platform === 'win32' && asset.binWin ? asset.binWin : asset.bin).split('/');
  const bin = join(installDir, ...binRel);
  if (existsSync(bin)) return bin;
  if (!download) return null;
  console.error(`[code-atlas] downloading ${asset.url} (one-time, checksum-pinned)…`);
  const buf = await downloadVerified(asset.url, asset.sha256);
  if (!buf) return null;
  await extractTo(buf, asset.archive, installDir, binRel[binRel.length - 1]);
  if (process.platform !== 'win32' && existsSync(bin)) chmodSync(bin, 0o755);
  return existsSync(bin) ? bin : null;
}

/** Assemble the classic equinox launch for an extracted JDT LS tree. */
function jdtlsLaunch(installDir: string, javaCmd: string, rootDir: string): LaunchSpec | null {
  const pluginsDir = join(installDir, 'plugins');
  if (!existsSync(pluginsDir)) return null;
  const launcher = readdirSync(pluginsDir).find(
    (f) => f.startsWith('org.eclipse.equinox.launcher_') && f.endsWith('.jar'),
  );
  if (!launcher) return null;
  const config =
    process.platform === 'win32'
      ? 'config_win'
      : process.platform === 'darwin'
        ? process.arch === 'arm64' ? 'config_mac_arm' : 'config_mac'
        : process.arch === 'arm64' ? 'config_linux_arm' : 'config_linux';
  // each workspace needs its own writable metadata dir
  const dataDir = join(
    installDir, '..', 'jdtls-data',
    createHash('sha1').update(rootDir).digest('hex').slice(0, 12),
  );
  mkdirSync(dataDir, { recursive: true });
  return {
    command: javaCmd,
    args: [
      '-Declipse.application=org.eclipse.jdt.ls.core.id1',
      '-Dosgi.bundles.defaultStartLevel=4',
      '-Declipse.product=org.eclipse.jdt.ls.core.product',
      '-Xmx1G',
      '--add-modules=ALL-SYSTEM',
      '--add-opens', 'java.base/java.util=ALL-UNNAMED',
      '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
      '-jar', join(pluginsDir, launcher),
      '-configuration', join(installDir, config),
      '-data', dataDir,
    ],
  };
}

/**
 * Resolve a launchable server: PATH first, then the managed cache,
 * downloading into it when allowed. Null = structural-only for this server.
 */
export async function ensureServer(
  spec: ServerSpec,
  opts: { download: boolean; cacheDir: string; rootDir: string },
): Promise<LaunchSpec | null> {
  const onPath = findOnPath(spec.detectNames);
  if (onPath) return { command: onPath, args: spec.pathArgs };

  const acquire = spec.acquire;
  if (!acquire) return null;

  if (acquire.kind === 'binary') {
    if (acquire.requires === 'java' && !findJava()) return null;
    const asset = acquire.assets[platformKey()] ?? acquire.assets.any;
    if (!asset) return null;
    const bin = await ensureBinary(join(opts.cacheDir, spec.id), asset, opts.download);
    return bin ? { command: bin, args: acquire.args } : null;
  }

  if (acquire.kind === 'jdtls') {
    const java = findJava();
    if (!java || ((await javaMajor(java)) ?? 0) < 21) return null;
    const installDir = join(opts.cacheDir, spec.id);
    if (!existsSync(join(installDir, 'plugins'))) {
      if (!opts.download) return null;
      console.error(`[code-atlas] downloading Eclipse JDT LS (one-time, checksum-pinned)…`);
      const buf = await downloadVerified(acquire.url, acquire.sha256);
      if (!buf) return null;
      await extractTo(buf, 'tar.gz', installDir);
    }
    return jdtlsLaunch(installDir, java, opts.rootDir);
  }

  if (acquire.kind === 'dotnet-tool') {
    const dotnet = findDotnet();
    if (!dotnet) return null;
    const toolDir = join(opts.cacheDir, spec.id);
    const bin = join(toolDir, acquire.bin + (process.platform === 'win32' ? '.exe' : ''));
    if (!existsSync(bin)) {
      if (!opts.download) return null;
      console.error(`[code-atlas] installing ${acquire.package}@${acquire.version} (dotnet tool)…`);
      const ok = await runCommand(dotnet, [
        'tool', 'install', acquire.package,
        '--version', acquire.version,
        '--tool-path', toolDir,
        // machines often have only a VS offline feed configured — be explicit
        '--add-source', 'https://api.nuget.org/v3/index.json',
        '--ignore-failed-sources',
      ]);
      if (!ok || !existsSync(bin)) return null;
    }
    return { command: bin, args: acquire.args };
  }

  if (acquire.kind === 'npm') {
    const installDir = join(opts.cacheDir, spec.id);
    const entry = join(installDir, 'node_modules', ...acquire.entry.split('/'));
    if (!existsSync(entry)) {
      if (!opts.download) return null;
      mkdirSync(installDir, { recursive: true });
      const ok = await runCommand('npm', [
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
    const ok = await runCommand('go', ['install', acquire.module], { ...process.env, GOBIN: binDir });
    if (!ok || !existsSync(bin)) return null;
  }
  return { command: bin, args: acquire.args };
}
