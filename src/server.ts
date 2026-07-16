import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';
import { registerTools } from './tools/register.js';
import { PACKAGE_VERSION } from './version.js';

export const SERVER_NAME = 'code-atlas';
export const SERVER_VERSION = PACKAGE_VERSION;

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'code-atlas indexes this workspace with tree-sitter and serves structured code intelligence. ' +
        'Start with project_overview. The token-saving entry points: context_pack returns a budgeted ' +
        'one-call briefing on a symbol (source, outline, callers/callees, types, route, tests) instead ' +
        'of several lookups, and verify_changes checks your uncommitted edits against git HEAD for ' +
        'broken imports, stranded references, and signature changes with live callers — call it after ' +
        'editing, before running tests. Use get_file_outline instead of reading whole files, ' +
        'search_symbols to locate definitions by name, semantic_search to find code by what it ' +
        'does in plain language, get_symbol_info (include_source=true) to read one definition, ' +
        'batch_symbols to resolve many #ids at once, and ast_query for structural searches. ' +
        'For flow questions use find_references (who uses this), call_hierarchy, type_hierarchy, ' +
        'get_dependencies (file import graph), trace_path (call chain between two symbols), ' +
        'change_impact (blast radius with affected TEST files — no arguments analyzes the uncommitted ' +
        'git diff), and tests_for_symbol (which tests exercise this). find_similar_code answers ' +
        '"does a helper for this already exist?"; find_dead_code and hotspots report unreferenced ' +
        'symbols (hedged, verify before deleting) and churn-ranked risk files. Web-framework routes ' +
        'are indexed (Express/Fastify/NestJS/FastAPI/Flask/Django plus file-based Next.js/SvelteKit/' +
        'Nuxt/Remix): list_routes enumerates them, find_route answers "which code serves this URL". ' +
        'List-shaped tools accept max_tokens to cap response size. Graph results are structural: each ' +
        'edge carries a confidence score; treat low-confidence edges as hints. The index refreshes ' +
        'automatically while serving (file watcher) and manually via reindex.',
    },
  );
  registerTools(server, ctx);
  return server;
}
