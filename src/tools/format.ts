import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { AppContext } from '../context.js';
import type { SymbolRow } from '../types.js';

/** Standard MCP text response envelope. */
export function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

/** Accept absolute or relative, forward or back slashes; return root-relative forward-slash path. */
export function normalizeRel(ctx: AppContext, p: string): string {
  const withSlashes = p.replace(/\\/g, '/');
  const rel = /^[a-zA-Z]:\//.test(withSlashes) || withSlashes.startsWith('/')
    ? relative(ctx.config.root, p).split(sep).join('/')
    : withSlashes;
  return rel.replace(/^\.\//, '');
}

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

const NON_CALLABLE_KINDS: ReadonlySet<string> = new Set([
  'interface', 'trait', 'enum', 'type_alias', 'struct',
]);
const TYPE_LIKE_KINDS: ReadonlySet<string> = new Set([
  'class', 'interface', 'struct', 'trait', 'enum', 'type_alias',
]);

/**
 * Explains an empty call/type graph as an answer, not a failure: wrong-kind targets get a
 * redirect, genuinely edge-less symbols get "stands alone" plus an honest coverage hedge.
 * For family 'types', direction 'out' means supertypes and 'in' subtypes (edges point
 * subtype -> supertype).
 */
export function emptyGraphNote(
  sym: Pick<SymbolRow, 'kind' | 'qualifiedName' | 'path'>,
  family: 'calls' | 'types',
  direction: 'in' | 'out' | 'both',
): string {
  const who = `${sym.kind} ${sym.qualifiedName}`;
  if (family === 'calls') {
    if (NON_CALLABLE_KINDS.has(sym.kind)) {
      return `${who} is not callable — call graphs cover functions and methods; its type hierarchy may be what you want`;
    }
    if (sym.kind === 'class') {
      return `${who} has no call edges in the index — calls attach to its methods and constructor; target one of those (get_file_outline ${sym.path} lists them)`;
    }
    const what =
      direction === 'in'
        ? 'nothing in the index calls it'
        : direction === 'out'
          ? 'it calls nothing the resolver could see'
          : 'nothing in the index calls it, and it calls nothing the resolver could see';
    return `${who}: ${what} (structural index — dynamic or indirect calls may be missing)`;
  }
  if (!TYPE_LIKE_KINDS.has(sym.kind)) {
    return `${who} is not a type — inheritance diagrams cover classes, interfaces, structs, and traits; its call graph may be what you want`;
  }
  const what =
    direction === 'out'
      ? 'no supertypes in the index'
      : direction === 'in'
        ? 'no subtypes in the index'
        : 'no supertypes or subtypes in the index — it stands alone';
  return `${who}: ${what} (cross-file inheritance resolves heuristically — a missed link is possible)`;
}
