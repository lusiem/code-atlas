// Assembles grammars/ (shipped in the npm package) from two sources:
//   1. @vscode/tree-sitter-wasm — prebuilt, ABI-compatible with our
//      web-tree-sitter (verified by the test suite)
//   2. pinned GitHub release assets, verified against SHA-256 checksums below
//
// Still missing (Phase 6): gdscript, godot_resource — see docs/grammars.md.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// left side: our canonical language id; right side: vscode wasm file stem
const VSCODE_GRAMMARS = {
  typescript: 'typescript',
  tsx: 'tsx',
  javascript: 'javascript',
  python: 'python',
  cpp: 'cpp',
  rust: 'rust',
  go: 'go',
  java: 'java',
  c_sharp: 'c-sharp',
};

// pinned release downloads: bump the version and checksum together
const DOWNLOAD_GRAMMARS = {
  c: {
    url: 'https://github.com/tree-sitter/tree-sitter-c/releases/download/v0.24.2/tree-sitter-c.wasm',
    sha256: '83e8d7902b9d7f8c7c5cd4bd9acb5c7eb5faf42c09f85546b183964d3b5f48f9',
  },
  kotlin: {
    url: 'https://github.com/fwcd/tree-sitter-kotlin/releases/download/0.3.8/tree-sitter-kotlin.wasm',
    sha256: 'c624e7443b371c28adc5d81674e73067564c12555ebe3ed96a6c8db814b7602d',
  },
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const srcDir = join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');
const destDir = join(root, 'grammars');
mkdirSync(destDir, { recursive: true });

for (const [id, stem] of Object.entries(VSCODE_GRAMMARS)) {
  copyFileSync(join(srcDir, `tree-sitter-${stem}.wasm`), join(destDir, `tree-sitter-${id}.wasm`));
  console.log(`copied tree-sitter-${id}.wasm`);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

for (const [id, { url, sha256: expected }] of Object.entries(DOWNLOAD_GRAMMARS)) {
  const dest = join(destDir, `tree-sitter-${id}.wasm`);
  if (existsSync(dest) && sha256(readFileSync(dest)) === expected) {
    console.log(`tree-sitter-${id}.wasm already present (checksum ok)`);
    continue;
  }
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`FAILED to download ${url}: HTTP ${res.status} — ${id} will not be indexable`);
    continue; // grammar downloads are best-effort: the server runs without them
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== expected) {
    console.error(`CHECKSUM MISMATCH for ${id}: expected ${expected}, got ${actual} — skipping`);
    continue;
  }
  writeFileSync(dest, buf);
  console.log(`downloaded tree-sitter-${id}.wasm (checksum ok)`);
}
