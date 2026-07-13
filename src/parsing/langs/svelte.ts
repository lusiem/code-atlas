import type { LanguageExtractor } from '../extractor.js';
import { typescriptExtractor } from './ecmascript.js';
import { blankOutsideScript } from './sfc.js';

/**
 * Svelte components parse as JS/TS once the markup is blanked: `$:` labels,
 * runes ($state()), and `export let` props are all valid script syntax with
 * the right semantics (props even report as exported variables).
 */
export const svelteExtractor: LanguageExtractor = {
  ...typescriptExtractor,
  id: 'svelte',
  preprocess: blankOutsideScript,
};
