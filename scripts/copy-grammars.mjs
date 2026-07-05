// Copies prebuilt tree-sitter grammar .wasm files from @vscode/tree-sitter-wasm
// (ABI-compatible with our web-tree-sitter version; verified by test/grammars.test.ts)
// into grammars/, which is shipped in the npm package.
//
// Not available prebuilt there (acquired separately, see docs/grammars.md):
//   - c        (Phase 2: official tree-sitter-c GitHub release wasm)
//   - kotlin   (Phase 2: fwcd/tree-sitter-kotlin)
//   - gdscript, godot_resource (Phase 6)
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// left side: our canonical language id; right side: vscode wasm file stem
const GRAMMARS = {
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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const srcDir = join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');
const destDir = join(root, 'grammars');
mkdirSync(destDir, { recursive: true });

for (const [id, stem] of Object.entries(GRAMMARS)) {
  copyFileSync(join(srcDir, `tree-sitter-${stem}.wasm`), join(destDir, `tree-sitter-${id}.wasm`));
  console.log(`copied tree-sitter-${id}.wasm`);
}
