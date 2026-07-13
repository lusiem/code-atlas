import type { LanguageId } from '../types.js';

/**
 * Path-based test-file classification. Purely lexical — no file contents.
 * Known gaps, by design: Rust inline `#[cfg(test)] mod tests` and Zig inline
 * `test` blocks live inside production files and cannot be classified by path.
 */

/** Directory segments that mark a test file in any language. */
const GENERIC_TEST_DIRS = /(^|\/)(test|tests)\//;

type Matcher = (path: string, base: string) => boolean;

const seg = (re: RegExp): Matcher => (path) => re.test(path);
const name = (re: RegExp): Matcher => (_path, base) => re.test(base);

const LANG_MATCHERS: Partial<Record<LanguageId, Matcher[]>> = {
  typescript: ecmaMatchers(),
  tsx: ecmaMatchers(),
  javascript: ecmaMatchers(),
  vue: ecmaMatchers(),
  svelte: ecmaMatchers(),
  python: [name(/^test_.*\.py$/), name(/_test\.py$/), name(/^conftest\.py$/)],
  go: [name(/_test\.go$/)],
  java: [seg(/(^|\/)src\/(test|androidTest)\//), name(/(Test|Tests|IT)\.java$/)],
  kotlin: [seg(/(^|\/)src\/(test|androidTest)\//), name(/(Test|Tests)\.kt$/)],
  c_sharp: [name(/(Test|Tests)\.cs$/), seg(/(^|\/)[^/]+\.Tests\//i)],
  c: cLikeMatchers(),
  cpp: cLikeMatchers(),
  rust: [name(/_test\.rs$/)],
  gdscript: [name(/^test_.*\.gd$/)],
  php: [name(/Test\.php$/)],
  ruby: [seg(/(^|\/)spec\//), name(/_(spec|test)\.rb$/)],
  lua: [name(/_spec\.lua$/), name(/^test_.*\.lua$/), seg(/(^|\/)spec\//)],
  solidity: [name(/\.t\.sol$/)], // foundry convention
  zig: [], // inline `test` blocks — not path-classifiable
  nix: [],
  swift: [name(/Tests?\.swift$/), seg(/(^|\/)\w*Tests\//)],
  scala: [seg(/(^|\/)src\/(test|it)\//), name(/(Spec|Suite|Test)\.scala$/)],
  dart: [name(/_test\.dart$/)],
  terraform: [], // no test-file convention
  pascal: [name(/^Test.*\.pas$/i), name(/Tests?\.pas$/i)],
};

function ecmaMatchers(): Matcher[] {
  return [
    name(/\.(test|spec)\.[cm]?[jt]sx?$/),
    name(/\.e2e-spec\.[jt]s$/),
    seg(/(^|\/)(__tests__|__mocks__|cypress|e2e)\//),
  ];
}

function cLikeMatchers(): Matcher[] {
  return [name(/(_test|_unittest)\.(c|cc|cpp|cxx)$/), name(/^test_.*\.(c|cc|cpp|cxx)$/)];
}

/** True when a root-relative, forward-slash path is a test file for its language. */
export function isTestPath(path: string, lang: LanguageId): boolean {
  if (GENERIC_TEST_DIRS.test(path)) return true;
  const base = path.slice(path.lastIndexOf('/') + 1);
  const matchers = LANG_MATCHERS[lang];
  if (!matchers) return false;
  return matchers.some((m) => m(path, base));
}
