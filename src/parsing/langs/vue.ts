import type { LanguageExtractor } from '../extractor.js';
import { typescriptExtractor } from './ecmascript.js';
import { blankOutsideScript } from './sfc.js';

/**
 * Vue SFC = the typescript extractor over blanked-outside-<script> source
 * (grammar alias in the loader; TS parses untyped scripts too — tsx would
 * break on angle-bracket generics). Template-section component usage is out
 * of scope.
 */
export const vueExtractor: LanguageExtractor = {
  ...typescriptExtractor,
  id: 'vue',
  preprocess: blankOutsideScript,
};
