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
]);

export function extractorFor(lang: LanguageId): LanguageExtractor | undefined {
  return extractors.get(lang);
}

export function supportedLanguages(): LanguageId[] {
  return [...extractors.keys()];
}
