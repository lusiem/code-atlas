import type { LanguageId } from './types.js';

export interface LanguageInfo {
  id: LanguageId;
  extensions: string[];
}

export const LANGUAGES: LanguageInfo[] = [
  { id: 'typescript', extensions: ['.ts', '.mts', '.cts'] },
  { id: 'tsx', extensions: ['.tsx'] },
  { id: 'javascript', extensions: ['.js', '.mjs', '.cjs', '.jsx'] },
  { id: 'python', extensions: ['.py', '.pyi'] },
  { id: 'c', extensions: ['.c'] },
  { id: 'cpp', extensions: ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.h', '.inl'] },
  { id: 'rust', extensions: ['.rs'] },
  { id: 'go', extensions: ['.go'] },
  { id: 'java', extensions: ['.java'] },
  { id: 'kotlin', extensions: ['.kt', '.kts'] },
  { id: 'c_sharp', extensions: ['.cs'] },
  { id: 'gdscript', extensions: ['.gd'] },
  { id: 'php', extensions: ['.php'] },
  { id: 'ruby', extensions: ['.rb', '.rake', '.gemspec'] },
  { id: 'lua', extensions: ['.lua'] },
  { id: 'solidity', extensions: ['.sol'] },
  { id: 'zig', extensions: ['.zig'] },
  { id: 'nix', extensions: ['.nix'] },
  { id: 'swift', extensions: ['.swift'] },
  { id: 'scala', extensions: ['.scala', '.sc'] },
  { id: 'dart', extensions: ['.dart'] },
  { id: 'terraform', extensions: ['.tf', '.tfvars', '.hcl'] },
  { id: 'pascal', extensions: ['.pas', '.pp', '.dpr', '.lpr'] },
  { id: 'vue', extensions: ['.vue'] },
  { id: 'svelte', extensions: ['.svelte'] },
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
