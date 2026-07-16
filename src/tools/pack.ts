import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { SymbolRow } from '../types.js';
import type { EdgeRow } from '../db/store.js';
import { testsForSymbol } from '../analysis/tests-for.js';
import { semanticSearch } from '../embeddings/search.js';
import { lspHoverIfRunning } from '../lsp/overlay.js';
import { formatSymbolLine, readSnippet, renderOutline, text } from './format.js';
import { CALL_KINDS, TYPE_KINDS, findSymbol, symbolArgs } from './graph.js';
import { estimateTokens } from './tokens.js';

interface Section {
  name: string;
  lines: string[];
}

const EDGE_TOP = 8;
const OUTLINE_CAP = 30;
const TEST_TOP = 5;

function edgeLine(e: EdgeRow): string {
  return `${e.symbolKind} ${e.qualifiedName} (${e.path}:${e.startLine}) #${e.symbolId} [${e.provenance} ${e.confidence.toFixed(2)}]`;
}

function edgeSection(ctx: AppContext, sym: SymbolRow, direction: 'in' | 'out', name: string): Section | null {
  const edges = ctx.store.edgesFor(sym.id, direction, CALL_KINDS);
  if (edges.length === 0) return null;
  const lines = edges.slice(0, EDGE_TOP).map(edgeLine);
  if (edges.length > EDGE_TOP) lines.push(`(+${edges.length - EDGE_TOP} more — call_hierarchy for the full tree)`);
  return { name, lines };
}

export function registerPackTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'context_pack',
    {
      title: 'Context pack',
      description:
        'One-call, token-budgeted briefing on a symbol: definition source, surrounding file outline, ' +
        'type context, top callers/callees, route (if a handler), and related tests — instead of ' +
        'stitching six separate lookups. Sections that exceed the budget are named so you can ask for ' +
        'them specifically. Optional task string pulls in possibly relevant symbols.',
      inputSchema: {
        ...symbolArgs,
        task: z.string().optional()
          .describe('what you are about to do, in plain language — biases which sections matter'),
        max_tokens: z.number().int().min(500).max(20000).default(4000)
          .describe('soft cap on response size in estimated tokens'),
      },
    },
    async (args) => {
      const found = findSymbol(ctx, args);
      if (!found.ok) return text(found.message);
      const sym = found.sym;

      // header: always included, whatever the budget
      const header: string[] = [
        `${sym.kind} ${sym.qualifiedName}  (${sym.path}:${sym.startLine}-${sym.endLine}) #${sym.id}`,
        `lang: ${sym.lang}   exported: ${sym.isExported}`,
      ];
      if (sym.signature) header.push(`signature: ${sym.signature}`);
      if (sym.parentSymbolId !== null) {
        const parent = ctx.store.getSymbolById(sym.parentSymbolId);
        if (parent) header.push(`container: ${parent.kind} ${parent.qualifiedName} #${parent.id}`);
      }
      if (sym.docComment) header.push('', ...sym.docComment.split('\n').slice(0, 6));

      const sections: Section[] = [];
      const add = (s: Section | null): void => {
        if (s && s.lines.length > 0) sections.push(s);
      };

      try {
        add({ name: 'source', lines: [readSnippet(ctx.config.root, sym.path, sym.startLine, sym.endLine, 60)] });
      } catch {
        // file unreadable — the header still locates it
      }

      const fileSymbols = ctx.store
        .symbolsForFile(sym.fileId)
        .filter((s) => s.parentSymbolId === null && s.id !== sym.id);
      if (fileSymbols.length > 0) {
        const lines = renderOutline(fileSymbols).slice(0, OUTLINE_CAP);
        if (fileSymbols.length > OUTLINE_CAP) lines.push(`(+${fileSymbols.length - OUTLINE_CAP} more — get_file_outline)`);
        add({ name: `rest of ${sym.path}`, lines });
      }

      const typeLines: string[] = [];
      for (const e of ctx.store.edgesFor(sym.id, 'out', TYPE_KINDS).slice(0, 5)) {
        typeLines.push(`${e.edgeKind} ${edgeLine(e)}`);
      }
      for (const e of ctx.store.edgesFor(sym.id, 'in', TYPE_KINDS).slice(0, 5)) {
        typeLines.push(`subtype ${edgeLine(e)}`);
      }
      const hover = await lspHoverIfRunning(ctx, sym);
      if (hover) typeLines.push('hover (lsp):', hover);
      add({ name: 'type context', lines: typeLines });

      add(edgeSection(ctx, sym, 'in', 'callers'));
      add(edgeSection(ctx, sym, 'out', 'callees'));

      const routes = ctx.store.routesForSymbols([sym.id]).get(sym.id);
      if (routes) add({ name: 'route', lines: routes.map((r) => `ROUTE ${r.method} ${r.path}`) });

      const tests = testsForSymbol(ctx, sym, 4);
      if (tests.hits.length > 0) {
        const lines = tests.hits.slice(0, TEST_TOP).map((h) =>
          h.caseSymbol
            ? `TEST ${formatSymbolLine(h.caseSymbol)} — via ${h.via}`
            : `TEST ${h.testFile} (import chain)`,
        );
        add({ name: 'related tests', lines });
      }

      if (args.task) {
        const result = await semanticSearch(ctx, args.task, 5);
        const lines = result.hits
          .filter((h) => h.symbol.id !== sym.id)
          .map((h) => formatSymbolLine(h.symbol));
        add({ name: 'possibly relevant to the task', lines });
      }

      // greedy assembly: sections in priority order until the budget is spent.
      // a task that mentions tests promotes the related-tests section.
      const order = sections.slice();
      if (args.task && /\btests?\b/i.test(args.task)) {
        const i = order.findIndex((s) => s.name === 'related tests');
        if (i > 1) order.splice(1, 0, ...order.splice(i, 1));
      }
      const out: string[] = [...header];
      let remaining = args.max_tokens - estimateTokens(out.join('\n'));
      const omitted: string[] = [];
      for (const section of order) {
        const body = [``, `--- ${section.name} ---`, ...section.lines];
        const cost = estimateTokens(body.join('\n'));
        if (cost > remaining) {
          omitted.push(section.name);
          continue;
        }
        remaining -= cost;
        out.push(...body);
      }
      if (omitted.length > 0) {
        out.push('', `omitted (over budget): ${omitted.join(', ')} — raise max_tokens for the full pack`);
      }
      return text(out.join('\n'));
    },
  );
}
