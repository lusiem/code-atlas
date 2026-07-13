import { describe, expect, it } from 'vitest';
import { isTestPath } from '../src/analysis/testish.js';
import type { LanguageId } from '../src/types.js';

const CASES: Array<[string, LanguageId, boolean]> = [
  // ecmascript
  ['src/util.test.ts', 'typescript', true],
  ['src/util.spec.tsx', 'tsx', true],
  ['src/app.e2e-spec.ts', 'typescript', true],
  ['src/__tests__/util.ts', 'typescript', true],
  ['src/__mocks__/fs.js', 'javascript', true],
  ['cypress/support/index.js', 'javascript', true],
  ['src/util.ts', 'typescript', false],
  ['src/contest.ts', 'typescript', false], // "test" inside a word is not a segment
  ['src/latest/util.ts', 'typescript', false],
  // python
  ['pkg/test_util.py', 'python', true],
  ['pkg/util_test.py', 'python', true],
  ['conftest.py', 'python', true],
  ['tests/helpers.py', 'python', true],
  ['pkg/util.py', 'python', false],
  // go
  ['pkg/util_test.go', 'go', true],
  ['pkg/util.go', 'go', false],
  // jvm
  ['src/test/java/FooTest.java', 'java', true],
  ['app/src/androidTest/kotlin/FooTest.kt', 'kotlin', true],
  ['src/main/java/FooTest.java', 'java', true], // basename convention alone suffices
  ['src/main/java/Foo.java', 'java', false],
  // c#
  ['Project.Tests/FooTests.cs', 'c_sharp', true],
  ['Project/Foo.cs', 'c_sharp', false],
  // c/c++
  ['src/foo_test.cc', 'cpp', true],
  ['src/foo_unittest.cpp', 'cpp', true],
  ['src/foo.cpp', 'cpp', false],
  // rust
  ['tests/integration.rs', 'rust', true],
  ['src/lib.rs', 'rust', false],
  // gdscript
  ['scripts/test_player.gd', 'gdscript', true],
  ['scripts/player.gd', 'gdscript', false],
  // generic test-dir fallback applies to every language
  ['test/store.test.ts', 'typescript', true],
  ['tests/store.rs', 'rust', true],
];

describe('isTestPath', () => {
  for (const [path, lang, expected] of CASES) {
    it(`${path} (${lang}) -> ${expected}`, () => {
      expect(isTestPath(path, lang)).toBe(expected);
    });
  }
});
