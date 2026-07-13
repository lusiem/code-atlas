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
        'Start with project_overview. Use get_file_outline instead of reading whole files, ' +
        'search_symbols to locate definitions by name, semantic_search to find code by what it ' +
        'does in plain language, get_symbol_info (include_source=true) to read one ' +
        'definition, and ast_query for structural searches. For flow questions use find_references ' +
        '(who uses this), call_hierarchy (who calls this / what does it call), type_hierarchy ' +
        '(super/subtypes), get_dependencies (file import graph, both directions), trace_path ' +
        '(call chain between two symbols), and change_impact (blast radius of a change with ' +
        'affected TEST files highlighted — no arguments analyzes the uncommitted git diff). ' +
        'Web-framework routes (Express/Fastify/NestJS/FastAPI/Flask/Django) are indexed: ' +
        'list_routes enumerates them, find_route answers "which code serves this URL". ' +
        'Graph results are structural: each edge carries a ' +
        'confidence score; treat low-confidence edges as hints. The index refreshes automatically ' +
        'while serving (file watcher) and manually via reindex.',
    },
  );
  registerTools(server, ctx);
  return server;
}
