import type { LanguageExtractor } from './extractor.js';
import type { LanguageId } from '../types.js';
import {
  javascriptExtractor,
  tsxExtractor,
  typescriptExtractor,
} from './langs/ecmascript.js';
import { pythonExtractor } from './langs/python.js';

const extractors = new Map<LanguageId, LanguageExtractor>([
  ['typescript', typescriptExtractor],
  ['tsx', tsxExtractor],
  ['javascript', javascriptExtractor],
  ['python', pythonExtractor],
]);

export function extractorFor(lang: LanguageId): LanguageExtractor | undefined {
  return extractors.get(lang);
}

export function supportedLanguages(): LanguageId[] {
  return [...extractors.keys()];
}
