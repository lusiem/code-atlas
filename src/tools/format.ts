import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SymbolRow } from '../types.js';

/** Kind prefix, skipped when the signature already leads with the same keyword. */
export function kindPrefix(sym: Pick<SymbolRow, 'kind' | 'signature'>): string {
  const sig = sym.signature ?? '';
  const leading = sig.replace(/^export\s+(default\s+)?|^abstract\s+/g, '');
  const kindWords = new Map<string, string[]>([
    ['class', ['class']],
    ['interface', ['interface']],
    ['enum', ['enum', 'const enum']],
    ['namespace', ['namespace', 'module']],
    ['function', ['function', 'async function']],
    ['type_alias', ['type']],
    ['struct', ['struct']],
    ['trait', ['trait']],
  ]);
  for (const word of kindWords.get(sym.kind) ?? []) {
    if (leading.startsWith(`${word} `)) return '';
  }
  return `${sym.kind} `;
}

/** One-line symbol rendering: `kind name — signature  (path:line)` */
export function formatSymbolLine(sym: SymbolRow, opts?: { includeDoc?: boolean }): string {
  const sig = sym.signature && sym.signature !== sym.name ? ` — ${sym.signature}` : '';
  const exported = sym.isExported ? '' : ' [private]';
  let line = `${sym.kind} ${sym.qualifiedName}${sig}${exported}  (${sym.path}:${sym.startLine}) #${sym.id}`;
  if (opts?.includeDoc && sym.docComment) {
    const doc = sym.docComment.split('\n')[0]!;
    line += `\n    doc: ${doc}`;
  }
  return line;
}

export function readSnippet(
  root: string,
  relPath: string,
  startLine: number,
  endLine: number,
  maxLines = 40,
): string {
  const text = readFileSync(join(root, relPath), 'utf8');
  const lines = text.split(/\r?\n/);
  const from = Math.max(0, startLine - 1);
  const to = Math.min(lines.length, endLine, from + maxLines);
  const width = String(to).length;
  const body = lines
    .slice(from, to)
    .map((l, i) => `${String(from + 1 + i).padStart(width)}│ ${l}`)
    .join('\n');
  const truncated = endLine > to ? `\n… (${endLine - to} more lines through ${relPath}:${endLine})` : '';
  return body + truncated;
}

export function paginationFooter(shown: number, limit: number, offset: number): string {
  if (shown < limit) return '';
  return `\n(showing ${offset + 1}–${offset + shown}; pass offset=${offset + limit} for more)`;
}
