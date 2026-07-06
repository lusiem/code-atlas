import type { LanguageId } from './types.js';

export interface LanguageInfo {
  id: LanguageId;
  extensions: string[];
  /** Grammar wasm present in grammars/ today. */
  grammarAvailable: boolean;
}

export const LANGUAGES: LanguageInfo[] = [
  { id: 'typescript', extensions: ['.ts', '.mts', '.cts'], grammarAvailable: true },
  { id: 'tsx', extensions: ['.tsx'], grammarAvailable: true },
  { id: 'javascript', extensions: ['.js', '.mjs', '.cjs', '.jsx'], grammarAvailable: true },
  { id: 'python', extensions: ['.py', '.pyi'], grammarAvailable: true },
  { id: 'c', extensions: ['.c'], grammarAvailable: true },
  { id: 'cpp', extensions: ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.h', '.inl'], grammarAvailable: true },
  { id: 'rust', extensions: ['.rs'], grammarAvailable: true },
  { id: 'go', extensions: ['.go'], grammarAvailable: true },
  { id: 'java', extensions: ['.java'], grammarAvailable: true },
  { id: 'kotlin', extensions: ['.kt', '.kts'], grammarAvailable: true },
  { id: 'c_sharp', extensions: ['.cs'], grammarAvailable: true },
  { id: 'gdscript', extensions: ['.gd'], grammarAvailable: false },
];

const byExtension = new Map<string, LanguageInfo>();
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions) byExtension.set(ext, lang);
}

export function languageForPath(path: string): LanguageInfo | undefined {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return undefined;
  return byExtension.get(path.slice(dot).toLowerCase());
}
