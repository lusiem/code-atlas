import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { findSimilar } from '../analysis/similarity.js';
import { testsForSymbol } from '../analysis/tests-for.js';
import { verifyChanges } from '../analysis/verify.js';
import type { LanguageId } from '../types.js';
import { LANGUAGES } from '../languages.js';
import { formatSymbolLine, text } from './format.js';
import { findSymbol, symbolArgs } from './graph.js';
import { clampText, maxTokensArg } from './tokens.js';

export function registerAgentTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'tests_for_symbol',
    {
      title: 'Tests for symbol',
      description:
        'Which tests exercise this symbol? Walks the call/type graph backwards from the target to ' +
        'test files (strongest evidence, names the test-case symbol), then adds test files that only ' +
        'reach it through imports (weaker signal). Complements change_impact: this answers "what should ' +
        'I run?" for one symbol directly.',
      inputSchema: {
        ...symbolArgs,
        max_depth: z.number().int().min(1).max(15).default(6),
        min_confidence: z.number().min(0).max(1).default(0.5)
          .describe('ignore call edges below this confidence'),
        limit: z.number().int().min(1).max(200).default(30),
        ...maxTokensArg,
      },
    },
    async (args) => {
      const found = findSymbol(ctx, args);
      if (!found.ok) return text(found.message);
      const sym = found.sym;
      const result = testsForSymbol(ctx, sym, args.max_depth, args.min_confidence);

      const lines: string[] = [
        `tests exercising ${sym.kind} ${sym.qualifiedName} (${sym.path}:${sym.startLine}) #${sym.id}`,
      ];
      if (result.targetIsTest) {
        lines.push('note: the target itself is in a test file');
      }
      if (result.truncated) {
        lines.push('note: traversal truncated — deep fan-in; results may be incomplete');
      }
      if (result.hits.length === 0) {
        lines.push(
          'no test files reach this symbol through the indexed graph ' +
            '(structural index — dynamic dispatch and fixtures loaded by name are invisible)',
        );
        return text(lines.join('\n'));
      }

      const direct = result.hits.filter((h) => h.caseSymbol !== null).slice(0, args.limit);
      const viaImports = result.hits
        .filter((h) => h.caseSymbol === null)
        .slice(0, Math.max(0, args.limit - direct.length));
      if (direct.length > 0) {
        lines.push('');
        for (const h of direct) {
          lines.push(`TEST ${formatSymbolLine(h.caseSymbol!)} — via ${h.via}, depth ${h.depth}`);
        }
      }
      if (viaImports.length > 0) {
        lines.push('', 'import-chain only (no resolved call path — weaker signal):');
        for (const h of viaImports) lines.push(`TEST ${h.testFile} (depth ${h.depth})`);
      }
      const omitted = result.hits.length - direct.length - viaImports.length;
      if (omitted > 0) lines.push(`(+${omitted} more — raise limit)`);
      return text(clampText(lines.join('\n'), args.max_tokens));
    },
  );

  server.registerTool(
    'verify_changes',
    {
      title: 'Verify changes',
      description:
        'Post-edit structural check of the uncommitted working tree (or explicit files) against git HEAD: ' +
        'imports that stopped resolving, removed exports that other files still reference, and signature ' +
        'changes with live callers. change_impact predicts blast radius before an edit; this confirms what ' +
        'actually broke after. Waits for the index to catch up with the edits before answering.',
      inputSchema: {
        files: z.array(z.string()).optional()
          .describe('changed files to check (workspace-relative); omitted = uncommitted git diff'),
        ...maxTokensArg,
      },
    },
    async (args) => {
      const result = await verifyChanges(ctx, args.files);
      if ('error' in result) return text(result.error);
      const lines: string[] = [result.summary];
      for (const n of result.notes) lines.push(`note: ${n}`);
      if (result.findings.length === 0) {
        lines.push('', 'no structural breakage found (structural index — behavior changes and dynamic references are invisible; run the tests)');
      } else {
        lines.push('');
        for (const f of result.findings) lines.push(`${f.severity} ${f.message}`);
      }
      return text(clampText(lines.join('\n'), args.max_tokens));
    },
  );

  server.registerTool(
    'find_similar_code',
    {
      title: 'Find similar code',
      description:
        'Does a helper for this already exist? Near-duplicate search over the indexed code: target an ' +
        'existing symbol or paste a snippet. Uses local embedding vectors when ready ([cos]), degrading ' +
        'to token-shingle text similarity ([jaccard]) while embedding coverage builds.',
      inputSchema: {
        ...symbolArgs,
        snippet: z.string().optional()
          .describe('code or a description of it, when there is no existing symbol to compare'),
        k: z.number().int().min(1).max(50).default(10),
        min_similarity: z.number().min(0).max(1).default(0.8)
          .describe('cosine floor for embedding hits (the text fallback uses its own)'),
        lang: z.enum(LANGUAGES.map((l) => l.id) as [LanguageId, ...LanguageId[]]).optional(),
        ...maxTokensArg,
      },
    },
    async (args) => {
      let symbol;
      if (args.symbol_id !== undefined || args.path !== undefined || args.name !== undefined) {
        const found = findSymbol(ctx, args);
        if (!found.ok) return text(found.message);
        symbol = found.sym;
      } else if (!args.snippet) {
        return text('provide a symbol target (symbol_id / path+line / name) or a snippet');
      }
      const result = await findSimilar(ctx, {
        ...(symbol ? { symbol } : {}),
        ...(args.snippet ? { snippet: args.snippet } : {}),
        k: args.k,
        minSimilarity: args.min_similarity,
        ...(args.lang ? { lang: args.lang as LanguageId } : {}),
      });
      if ('error' in result) return text(result.error);
      const lines: string[] = [];
      if (symbol) lines.push(`similar to ${symbol.kind} ${symbol.qualifiedName} (${symbol.path}:${symbol.startLine}):`, '');
      if (result.hits.length === 0) {
        lines.push('no similar code found above the similarity floor');
      } else {
        for (const h of result.hits) {
          lines.push(`[${h.metric === 'cosine' ? 'cos' : 'jaccard'} ${h.score.toFixed(2)}] ${formatSymbolLine(h.symbol)}`);
        }
      }
      if (result.note) lines.push('', `(${result.note})`);
      return text(clampText(lines.join('\n'), args.max_tokens));
    },
  );
}
