// Publishability smoke: pack the package, verify the tarball carries
// everything a consumer needs, install it into a scratch project, and run
// the installed binary against a fixture. Exits nonzero on any failure.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// npm.cmd needs a shell on Windows; node (spaced path) must NOT use one
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', shell: cmd === npm && process.platform === 'win32', ...opts });

const scratch = mkdtempSync(join(tmpdir(), 'atlas-pack-'));
let failed = false;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed = true;
};

try {
  // 1. pack (runs `prepare`, which assembles grammars/)
  const rawPack = run(npm, ['pack', '--json', '--pack-destination', scratch], { cwd: root });
  // lifecycle-script output can precede the JSON — parse from the array start
  const packJson = JSON.parse(rawPack.slice(rawPack.indexOf('[\n')));
  const tarball = join(scratch, packJson[0].filename);
  const files = packJson[0].files.map((f) => f.path);
  const sizeMb = packJson[0].size / 1024 / 1024;
  console.log(`packed ${packJson[0].filename}: ${files.length} files, ${sizeMb.toFixed(1)} MB compressed`);

  // 2. tarball must be self-contained for consumers (prepare does NOT run
  //    on tarball installs — grammars have to ship inside)
  check(files.includes('dist/index.js'), 'dist/index.js in tarball');
  check(files.includes('LICENSE') && files.includes('README.md'), 'LICENSE + README in tarball');
  const grammarCount = files.filter((f) => f.startsWith('grammars/') && f.endsWith('.wasm')).length;
  check(grammarCount >= 12, `all grammar wasm files in tarball (${grammarCount}/12)`);
  check(!files.some((f) => f.startsWith('src/') || f.startsWith('test/')), 'no src/test in tarball');
  check(sizeMb < 40, `compressed size sane (${sizeMb.toFixed(1)} MB < 40 MB)`);

  // 3. install into a scratch project and run the installed bin
  run(npm, ['init', '-y'], { cwd: scratch, stdio: 'ignore' });
  run(npm, ['install', tarball, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: scratch });
  const installedEntry = join(scratch, 'node_modules', 'code-atlas', 'dist', 'index.js');
  check(existsSync(installedEntry), 'installed entry exists');
  check(
    existsSync(join(scratch, 'node_modules', 'code-atlas', 'grammars', 'tree-sitter-gdscript.wasm')),
    'vendored grammar installed',
  );

  const fixture = join(root, 'test', 'fixtures', 'ts-sample');
  const out = run(process.execPath, [installedEntry, 'index', '--root', fixture]);
  check(/indexed \d+ files, \d+ symbols/.test(out), `installed bin indexes a fixture (${out.trim()})`);
  rmSync(join(fixture, '.code-atlas'), { recursive: true, force: true });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failed) {
  console.error('PACK SMOKE FAILED');
  process.exit(1);
}
console.log('PACK SMOKE OK');
