import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { relative, sep } from 'node:path';
import type { AppContext } from '../context.js';
import type { EdgeKind, SymbolRow } from '../types.js';
import { lspCallHierarchy, lspReferences, relFromUri } from '../lsp/overlay.js';
import { formatSymbolLine, paginationFooter } from './format.js';

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function normalizeRel(ctx: AppContext, p: string): string {
  const withSlashes = p.replace(/\\/g, '/');
  const rel = /^[a-zA-Z]:\//.test(withSlashes) || withSlashes.startsWith('/')
    ? relative(ctx.config.root, p).split(sep).join('/')
    : withSlashes;
  return rel.replace(/^\.\//, '');
}

/** Shared `symbol_id | path+line | name` target schema for graph tools. */
const symbolArgs = {
  symbol_id: z.number().int().optional().describe('symbol id from search_symbols / get_file_outline'),
  path: z.string().optional().describe('with line: innermost symbol at that position'),
  line: z.number().int().min(1).optional(),
  name: z.string().optional().describe('exact symbol name (must be unambiguous)'),
};

interface SymbolArgIn {
  symbol_id?: number | undefined;
  path?: string | undefined;
  line?: number | undefined;
  name?: string | undefined;
}

type Found = { ok: true; sym: SymbolRow } | { ok: false; message: string };

function findSymbol(ctx: AppContext, args: SymbolArgIn, prefix = ''): Found {
  const { store } = ctx;
  const p = (k: string): string => (prefix ? `${prefix}${k}` : k);
  if (args.symbol_id !== undefined) {
    const row = store.getSymbolById(args.symbol_id);
    return row
      ? { ok: true, sym: row }
      : { ok: false, message: `no symbol with id ${args.symbol_id}` };
  }
  if (args.path && args.line !== undefined) {
    const rel = normalizeRel(ctx, args.path);
    const file = store.getFileByPath(rel);
    if (!file) return { ok: false, message: `file not indexed: ${rel}` };
    const row = store.symbolAt(file.id, args.line, Number.MAX_SAFE_INTEGER);
    return row
      ? { ok: true, sym: row }
      : { ok: false, message: `no symbol at ${rel}:${args.line}` };
  }
  if (args.name) {
    const matches = store
      .searchSymbols(args.name, { limit: 10, offset: 0 })
      .filter((r) => r.name === args.name || r.qualifiedName === args.name);
    if (matches.length === 1) return { ok: true, sym: matches[0]! };
    if (matches.length === 0) return { ok: false, message: `no symbol named "${args.name}"` };
    return {
      ok: false,
      message:
        `ambiguous "${args.name}" — pass ${p('symbol_id')} instead:\n` +
        matches.map((r) => formatSymbolLine(r)).join('\n'),
    };
  }
  return { ok: false, message: `provide ${p('symbol_id')}, ${p('path')}+${p('line')}, or ${p('name')}` };
}

function confidenceTag(confidence: number, provenance: string): string {
  return `[${provenance} ${confidence.toFixed(2)}]`;
}

const CALL_KINDS: EdgeKind[] = ['calls'];
const TYPE_KINDS: EdgeKind[] = ['extends', 'implements'];

/** BFS tree rendering over edges, cycle-safe. */
function renderHierarchy(
  ctx: AppContext,
  rootId: number,
  direction: 'out' | 'in',
  kinds: EdgeKind[],
  maxDepth: number,
  perNodeLimit: number,
): string[] {
  const lines: string[] = [];
  const visited = new Set<number>([rootId]);
  const walk = (id: number, depth: number): void => {
    if (depth > maxDepth) return;
    const edges = ctx.store.edgesFor(id, direction, kinds);
    for (const e of edges.slice(0, perNodeLimit)) {
      const indent = '  '.repeat(depth);
      const kindNote = kinds.length > 1 ? `${e.edgeKind} ` : '';
      lines.push(
        `${indent}${kindNote}${e.symbolKind} ${e.qualifiedName} (${e.path}:${e.startLine}) #${e.symbolId} ${confidenceTag(e.confidence, e.provenance)}`,
      );
      if (visited.has(e.symbolId)) {
        if (ctx.store.edgesFor(e.symbolId, direction, kinds).length > 0) {
          lines.push(`${indent}  (cycle — already shown)`);
        }
        continue;
      }
      visited.add(e.symbolId);
      walk(e.symbolId, depth + 1);
    }
    if (edges.length > perNodeLimit) {
      lines.push(`${'  '.repeat(depth)}(+${edges.length - perNodeLimit} more)`);
    }
  };
  walk(rootId, 1);
  return lines;
}

export function registerGraphTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'find_references',
    {
      title: 'Find references',
      description:
        'Usages of a symbol. Uses the exact language server when one is available (provenance lsp), ' +
        'falling back to indexed usages: resolved references first (with confidence), then unresolved ' +
        'same-name occurrences as candidates.',
      inputSchema: {
        ...symbolArgs,
        role: z.enum(['ref', 'call', 'write', 'import']).optional().describe('only usages of this kind'),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
      },
    },
    async (args) => {
      const found = findSymbol(ctx, args);
      if (!found.ok) return text(found.message);
      const sym = found.sym;
      const lines = [
        `definition: ${formatSymbolLine(sym)}`,
        '',
      ];

      // exact answer from the language server when available
      const precise = args.role ? null : await lspReferences(ctx, sym);
      if (precise && precise.length > 0) {
        const shown = precise.slice(args.offset, args.offset + args.limit);
        for (const r of shown) lines.push(`${r.path}:${r.line}:${r.col} (lsp)`);
        return text(
          lines.join('\n') + paginationFooter(shown.length, args.limit, args.offset),
        );
      }

      let refs = ctx.store.referencesTo(sym.id, sym.name, args.limit + 1, args.offset);
      if (args.role) refs = refs.filter((r) => r.role === args.role);
      if (refs.length === 0) {
        lines.push('no references found');
        return text(lines.join('\n'));
      }
      const shown = refs.slice(0, args.limit);
      for (const r of shown) {
        const status =
          r.resolvedSymbolId === sym.id
            ? `resolved ${r.confidence?.toFixed(2) ?? '?'}`
            : 'name match only';
        lines.push(`${r.path}:${r.startLine}:${r.startCol} ${r.role} (${status})`);
      }
      return text(lines.join('\n') + paginationFooter(shown.length, args.limit, args.offset));
    },
  );

  server.registerTool(
    'call_hierarchy',
    {
      title: 'Call hierarchy',
      description:
        'Who calls this symbol (direction=in) or what it calls (direction=out), as a tree up to `depth` levels. ' +
        'Uses the exact language server when available ([lsp 1.00] edges), structural index otherwise ' +
        '(confidence per edge).',
      inputSchema: {
        ...symbolArgs,
        direction: z.enum(['in', 'out']).default('in'),
        depth: z.number().int().min(1).max(3).default(2),
      },
    },
    async (args) => {
      const found = findSymbol(ctx, args);
      if (!found.ok) return text(found.message);
      const sym = found.sym;
      const direction = args.direction === 'in' ? 'in' : 'out';
      const header = `${args.direction === 'in' ? 'callers of' : 'calls from'} ${sym.kind} ${sym.qualifiedName} (${sym.path}:${sym.startLine}) #${sym.id}`;

      const precise = await lspCallHierarchy(ctx, sym, direction, args.depth, 25);
      if (precise && precise.length > 0) return text(`${header}\n${precise.join('\n')}`);

      const lines = renderHierarchy(ctx, sym.id, direction, CALL_KINDS, args.depth, 25);
      if (lines.length === 0) return text(`${header}\n(none found in the index)`);
      return text(`${header}\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'go_to_definition',
    {
      title: 'Go to definition',
      description:
        'Definition site of the identifier at a file position. Uses the exact language server when ' +
        'available, falling back to the structural index (resolved occurrence at that position).',
      inputSchema: {
        path: z.string().describe('file path, relative to the workspace root'),
        line: z.number().int().min(1).describe('1-based line of the identifier'),
        col: z.number().int().min(0).optional().describe('0-based column (defaults to first identifier on the line)'),
      },
    },
    async (args) => {
      const rel = normalizeRel(ctx, args.path);
      const file = ctx.store.getFileByPath(rel);
      if (!file) return text(`file not indexed: ${rel}`);
      const occ = ctx.store.occurrenceAt(file.id, args.line, args.col ?? null);

      const client = await ctx.lsp?.clientFor(file.lang);
      if (client) {
        const col = args.col ?? occ?.startCol ?? 0;
        const locs = await client.definition(rel, { line: args.line - 1, character: col });
        if (locs && locs.length > 0) {
          const lines = locs.map((loc) => {
            const target = relFromUri(ctx, loc.uri);
            return `${target ?? loc.uri}:${loc.range.start.line + 1}:${loc.range.start.character} (lsp)`;
          });
          return text(`definition of ${occ?.name ?? `${rel}:${args.line}`}:\n${lines.join('\n')}`);
        }
      }

      if (!occ) return text(`no identifier found at ${rel}:${args.line}`);
      if (occ.resolvedSymbolId !== null) {
        const target = ctx.store.getSymbolById(occ.resolvedSymbolId);
        if (target) {
          return text(
            `definition of ${occ.name}:\n${formatSymbolLine(target)} (index ${occ.confidence?.toFixed(2) ?? '?'})`,
          );
        }
      }
      const candidates = ctx.store
        .searchSymbols(occ.name, { limit: 5, offset: 0 })
        .filter((r) => r.name === occ.name);
      if (candidates.length === 0) return text(`"${occ.name}" is unresolved and has no indexed definition`);
      return text(
        `"${occ.name}" is unresolved; candidates:\n${candidates.map((r) => formatSymbolLine(r)).join('\n')}`,
      );
    },
  );

  server.registerTool(
    'type_hierarchy',
    {
      title: 'Type hierarchy',
      description:
        'Supertypes (direction=super: what this type extends/implements) or subtypes ' +
        '(direction=sub: what extends/implements it), as a tree.',
      inputSchema: {
        ...symbolArgs,
        direction: z.enum(['super', 'sub']).default('sub'),
        depth: z.number().int().min(1).max(5).default(3),
      },
    },
    async (args) => {
      const found = findSymbol(ctx, args);
      if (!found.ok) return text(found.message);
      const sym = found.sym;
      const dir = args.direction === 'super' ? 'out' : 'in';
      const lines = renderHierarchy(ctx, sym.id, dir, TYPE_KINDS, args.depth, 50);
      const header = `${args.direction === 'super' ? 'supertypes of' : 'subtypes of'} ${sym.kind} ${sym.qualifiedName} (${sym.path}:${sym.startLine}) #${sym.id}`;
      if (lines.length === 0) return text(`${header}\n(none found in the index)`);
      return text(`${header}\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'get_dependencies',
    {
      title: 'File dependencies',
      description:
        'What a file imports (direction=out) or which files import it (direction=in). ' +
        'Unresolved specifiers are external packages or system headers.',
      inputSchema: {
        path: z.string().describe('file path, relative to the workspace root'),
        direction: z.enum(['out', 'in']).default('out'),
      },
    },
    async (args) => {
      const rel = normalizeRel(ctx, args.path);
      const file = ctx.store.getFileByPath(rel);
      if (!file) return text(`file not indexed: ${rel}`);
      if (args.direction === 'out') {
        const deps = ctx.store.dependenciesOf(file.id);
        if (deps.length === 0) return text(`${rel}: no imports`);
        const lines = deps.map(
          (d) => `${rel}:${d.startLine}  ${d.specifier}  ->  ${d.resolvedPath ?? '(external)'}`,
        );
        return text(`imports of ${rel}:\n${lines.join('\n')}`);
      }
      const dependents = ctx.store.dependentsOf(file.id);
      if (dependents.length === 0) return text(`${rel}: no files in the workspace import it`);
      const lines = dependents.map((d) => `${d.path}:${d.startLine}  (as "${d.specifier}")`);
      return text(`files importing ${rel}:\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'trace_path',
    {
      title: 'Trace call path',
      description:
        'Shortest call chain from one symbol to another over the indexed call graph — ' +
        '"how does the request handler end up in the DB layer?". Both ends accept a symbol id or an exact name.',
      inputSchema: {
        from_id: z.number().int().optional(),
        from_name: z.string().optional(),
        to_id: z.number().int().optional(),
        to_name: z.string().optional(),
        max_depth: z.number().int().min(1).max(10).default(6),
      },
    },
    async (args) => {
      const from = findSymbol(ctx, { symbol_id: args.from_id, name: args.from_name }, 'from_');
      if (!from.ok) return text(from.message);
      const to = findSymbol(ctx, { symbol_id: args.to_id, name: args.to_name }, 'to_');
      if (!to.ok) return text(to.message);

      // BFS forward over call edges
      const prev = new Map<number, number>();
      const queue: number[] = [from.sym.id];
      const depthOf = new Map<number, number>([[from.sym.id, 0]]);
      let foundTarget = false;
      while (queue.length > 0 && !foundTarget) {
        const cur = queue.shift()!;
        const depth = depthOf.get(cur)!;
        if (depth >= args.max_depth) continue;
        for (const e of ctx.store.edgesFor(cur, 'out', CALL_KINDS)) {
          if (depthOf.has(e.symbolId)) continue;
          depthOf.set(e.symbolId, depth + 1);
          prev.set(e.symbolId, cur);
          if (e.symbolId === to.sym.id) {
            foundTarget = true;
            break;
          }
          queue.push(e.symbolId);
        }
      }

      if (!foundTarget) {
        return text(
          `no call path from ${from.sym.qualifiedName} to ${to.sym.qualifiedName} within depth ${args.max_depth} (structural index only — indirect/dynamic calls may be missing)`,
        );
      }
      const chain: number[] = [to.sym.id];
      while (chain[0] !== from.sym.id) chain.unshift(prev.get(chain[0]!)!);
      const lines = chain.map((id, i) => {
        const s = ctx.store.getSymbolById(id)!;
        return `${'  '.repeat(i)}${i > 0 ? '-> ' : ''}${s.kind} ${s.qualifiedName} (${s.path}:${s.startLine}) #${s.id}`;
      });
      return text(`call path (${chain.length - 1} hops):\n${lines.join('\n')}`);
    },
  );
}
