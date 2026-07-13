// Assembles grammars/ (shipped in the npm package) from two sources:
//   1. @vscode/tree-sitter-wasm — prebuilt, ABI-compatible with our
//      web-tree-sitter (verified by the test suite)
//   2. pinned GitHub release assets, verified against SHA-256 checksums below
//   3. grammars-vendored/ — wasm we build ourselves (no upstream distribution),
//      committed to the repo with provenance in grammars-vendored/README.md
// (.tscn/.tres/scene formats are hand-parsed — no grammar needed.)
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
  php: 'php',
  ruby: 'ruby',
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
  lua: {
    url: 'https://github.com/tree-sitter-grammars/tree-sitter-lua/releases/download/v0.5.0/tree-sitter-lua.wasm',
    sha256: 'df08a1704e504c70b8dba4a3e6f8e0c99a4fb94e1b1693d2969f53141d09f0d4',
  },
  zig: {
    url: 'https://github.com/tree-sitter-grammars/tree-sitter-zig/releases/download/v1.1.2/tree-sitter-zig.wasm',
    sha256: '54b3b83dd9c62da5815f06132bc3fc914d9dcc780370b32416446a0b7969e8c6',
  },
  swift: {
    url: 'https://github.com/alex-pinkus/tree-sitter-swift/releases/download/0.7.3/tree-sitter-swift.wasm',
    sha256: '0258a7ef17303a8079ffe0748b3583d59656b5c3e8653fca7b6451b3e6689eb2',
  },
  scala: {
    url: 'https://github.com/tree-sitter/tree-sitter-scala/releases/download/v0.26.0/tree-sitter-scala.wasm',
    sha256: '026c2f9a8374109861f6621f4759ef690faebcaa67c2d56b06af3786c206b030',
  },
  terraform: {
    url: 'https://github.com/tree-sitter-grammars/tree-sitter-hcl/releases/download/v1.2.0/tree-sitter-terraform.wasm',
    sha256: '59dbcbb0f08eb78b78f37510834559a48ce5c9d4866c978d62c6390796461cb5',
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

const vendoredDir = join(root, 'grammars-vendored');
if (existsSync(vendoredDir)) {
  const { readdirSync } = await import('node:fs');
  for (const file of readdirSync(vendoredDir).filter((f) => f.endsWith('.wasm'))) {
    copyFileSync(join(vendoredDir, file), join(destDir, file));
    console.log(`copied ${file} (vendored)`);
  }
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
