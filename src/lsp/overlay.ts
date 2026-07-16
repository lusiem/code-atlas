import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppContext } from '../context.js';
import type { SymbolRow } from '../types.js';
import type { LspClient } from './client.js';
import {
  hoverText,
  symbolKindName,
  type CallHierarchyItem,
  type LspPosition,
} from './protocol.js';

/**
 * Bridges index symbols to LSP positions. The index stores the definition
 * node's start; LSP wants the cursor on the identifier, so we scan the first
 * lines of the definition for the symbol's name.
 */
export function namePosition(ctx: AppContext, sym: SymbolRow): LspPosition | null {
  let source: string;
  try {
    source = readFileSync(join(ctx.config.root, sym.path), 'utf8');
  } catch {
    return null;
  }
  const lines = source.split(/\r?\n/);
  const startIdx = sym.startLine - 1;
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(sym.name)}(?![A-Za-z0-9_$])`);
  for (let i = startIdx; i < Math.min(startIdx + 5, lines.length); i++) {
    const fromCol = i === startIdx ? sym.startCol : 0;
    const m = pattern.exec(lines[i]!.slice(fromCol));
    if (m) return { line: i, character: fromCol + m.index };
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function relFromUri(ctx: AppContext, uri: string): string | null {
  try {
    const abs = fileURLToPath(uri);
    const rel = relative(ctx.config.root, abs).replaceAll('\\', '/');
    return rel.startsWith('..') ? null : rel;
  } catch {
    return null;
  }
}

async function clientForSymbol(ctx: AppContext, sym: SymbolRow): Promise<LspClient | null> {
  if (!ctx.lsp) return null;
  return ctx.lsp.clientFor(sym.lang);
}

export interface LspRef {
  path: string;
  line: number; // 1-based
  col: number; // 0-based
}

/** Precise references via LSP, or null when unavailable. */
export async function lspReferences(ctx: AppContext, sym: SymbolRow): Promise<LspRef[] | null> {
  const client = await clientForSymbol(ctx, sym);
  if (!client) return null;
  const pos = namePosition(ctx, sym);
  if (!pos) return null;
  let locs = await client.references(sym.path, pos);
  if (locs?.length === 0) {
    // freshly started servers answer [] before the project graph loads
    await new Promise((r) => setTimeout(r, 1500));
    locs = await client.references(sym.path, pos);
  }
  if (!locs) return null;
  const out: LspRef[] = [];
  for (const loc of locs) {
    const rel = relFromUri(ctx, loc.uri);
    if (rel) out.push({ path: rel, line: loc.range.start.line + 1, col: loc.range.start.character });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  return out;
}

/** Hover markdown for a symbol via LSP, trimmed for tool output. */
export async function lspHoverFor(ctx: AppContext, sym: SymbolRow): Promise<string | null> {
  const client = await clientForSymbol(ctx, sym);
  if (!client) return null;
  const pos = namePosition(ctx, sym);
  if (!pos) return null;
  const text = hoverText(await client.hover(sym.path, pos));
  if (!text) return null;
  const lines = text.split('\n');
  return lines.length > 30 ? `${lines.slice(0, 30).join('\n')}\n…` : text;
}

/**
 * Hover via an already-running server only — never triggers a server start.
 * For callers (context_pack) that enrich opportunistically and must not pay
 * the start budget.
 */
export async function lspHoverIfRunning(ctx: AppContext, sym: SymbolRow): Promise<string | null> {
  const client = ctx.lsp?.runningClientFor(sym.lang) ?? null;
  if (!client) return null;
  const pos = namePosition(ctx, sym);
  if (!pos) return null;
  const text = hoverText(await client.hover(sym.path, pos));
  if (!text) return null;
  const lines = text.split('\n');
  return lines.length > 12 ? `${lines.slice(0, 12).join('\n')}\n…` : text;
}

/**
 * LSP call hierarchy rendered like the structural one; discovered edges are
 * cached into the index with provenance 'lsp', confidence 1.0.
 */
export async function lspCallHierarchy(
  ctx: AppContext,
  sym: SymbolRow,
  direction: 'in' | 'out',
  depth: number,
  perNode: number,
): Promise<string[] | null> {
  const client = await clientForSymbol(ctx, sym);
  if (!client) return null;
  const pos = namePosition(ctx, sym);
  if (!pos) return null;
  const root = await client.prepareCallHierarchy(sym.path, pos);
  if (!root) return null;

  const lines: string[] = [];
  const edges: Array<{ srcSymbolId: number; dstSymbolId: number }> = [];
  const visited = new Set<string>([itemKey(root)]);

  const walk = async (item: CallHierarchyItem, level: number): Promise<void> => {
    if (level > depth) return;
    const calls =
      direction === 'in' ? await client.incomingCalls(item) : await client.outgoingCalls(item);
    if (!calls) return;
    for (const call of calls.slice(0, perNode)) {
      const next = 'from' in call ? call.from : call.to;
      const rel = relFromUri(ctx, next.uri);
      const line1 = next.selectionRange.start.line + 1;
      const indent = '  '.repeat(level);
      const idNote = rel ? indexSymbolNote(ctx, rel, line1) : '';
      const loc = rel ?? next.uri;
      lines.push(
        `${indent}${symbolKindName(next.kind)} ${next.name} (${loc}:${line1})${idNote} [lsp 1.00]`,
      );
      if (rel) {
        const edge = edgeBetween(ctx, sym, item, next, direction, rel, line1);
        if (edge) edges.push(edge);
      }
      const key = itemKey(next);
      if (visited.has(key)) {
        lines.push(`${indent}  (cycle — already shown)`);
        continue;
      }
      visited.add(key);
      await walk(next, level + 1);
    }
    if (calls.length > perNode) {
      lines.push(`${'  '.repeat(level)}(+${calls.length - perNode} more)`);
    }
  };
  await walk(root, 1);

  if (edges.length > 0) {
    ctx.store.insertEdges(
      edges.map((e) => ({ ...e, kind: 'calls' as const, confidence: 1, provenance: 'lsp' as const })),
    );
  }
  return lines;
}

function itemKey(item: CallHierarchyItem): string {
  return `${item.uri}:${item.selectionRange.start.line}:${item.selectionRange.start.character}`;
}

/** #id suffix when an LSP item maps onto an indexed symbol. */
function indexSymbolNote(ctx: AppContext, rel: string, line1: number): string {
  const id = indexSymbolId(ctx, rel, line1);
  return id === null ? '' : ` #${id}`;
}

function indexSymbolId(ctx: AppContext, rel: string, line1: number): number | null {
  const file = ctx.store.getFileByPath(rel);
  if (!file) return null;
  const row = ctx.store.symbolAt(file.id, line1, Number.MAX_SAFE_INTEGER);
  return row?.id ?? null;
}

function edgeBetween(
  ctx: AppContext,
  rootSym: SymbolRow,
  parent: CallHierarchyItem,
  next: CallHierarchyItem,
  direction: 'in' | 'out',
  nextRel: string,
  nextLine1: number,
): { srcSymbolId: number; dstSymbolId: number } | null {
  const parentRel = relFromUri(ctx, parent.uri);
  const parentId = parentRel
    ? indexSymbolId(ctx, parentRel, parent.selectionRange.start.line + 1)
    : rootSym.id;
  const nextId = indexSymbolId(ctx, nextRel, nextLine1);
  if (parentId === null || nextId === null || parentId === nextId) return null;
  return direction === 'in'
    ? { srcSymbolId: nextId, dstSymbolId: parentId }
    : { srcSymbolId: parentId, dstSymbolId: nextId };
}
