import type { LanguageExtractor } from './extractor.js';
import type { LanguageId } from '../types.js';
import {
  javascriptExtractor,
  tsxExtractor,
  typescriptExtractor,
} from './langs/ecmascript.js';
import { pythonExtractor } from './langs/python.js';
import { cExtractor } from './langs/c.js';
import { cppExtractor } from './langs/cpp.js';
import { kotlinExtractor } from './langs/kotlin.js';
import { rustExtractor } from './langs/rust.js';
import { goExtractor } from './langs/go.js';
import { javaExtractor } from './langs/java.js';
import { csharpExtractor } from './langs/csharp.js';
import { gdscriptExtractor } from './langs/gdscript.js';
import { phpExtractor } from './langs/php.js';
import { rubyExtractor } from './langs/ruby.js';
import { luaExtractor } from './langs/lua.js';
import { solidityExtractor } from './langs/solidity.js';
import { zigExtractor } from './langs/zig.js';
import { nixExtractor } from './langs/nix.js';
import { swiftExtractor } from './langs/swift.js';
import { scalaExtractor } from './langs/scala.js';
import { dartExtractor } from './langs/dart.js';
import { terraformExtractor } from './langs/terraform.js';
import { pascalExtractor } from './langs/pascal.js';
import { vueExtractor } from './langs/vue.js';
import { svelteExtractor } from './langs/svelte.js';

const extractors = new Map<LanguageId, LanguageExtractor>([
  ['typescript', typescriptExtractor],
  ['tsx', tsxExtractor],
  ['javascript', javascriptExtractor],
  ['python', pythonExtractor],
  ['c', cExtractor],
  ['cpp', cppExtractor],
  ['kotlin', kotlinExtractor],
  ['rust', rustExtractor],
  ['go', goExtractor],
  ['java', javaExtractor],
  ['c_sharp', csharpExtractor],
  ['gdscript', gdscriptExtractor],
  ['php', phpExtractor],
  ['ruby', rubyExtractor],
  ['lua', luaExtractor],
  ['solidity', solidityExtractor],
  ['zig', zigExtractor],
  ['nix', nixExtractor],
  ['swift', swiftExtractor],
  ['scala', scalaExtractor],
  ['dart', dartExtractor],
  ['terraform', terraformExtractor],
  ['pascal', pascalExtractor],
  ['vue', vueExtractor],
  ['svelte', svelteExtractor],
]);

export function extractorFor(lang: LanguageId): LanguageExtractor | undefined {
  return extractors.get(lang);
}

export function supportedLanguages(): LanguageId[] {
  return [...extractors.keys()];
}
