import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { testsForSymbol } from '../analysis/tests-for.js';
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
}
