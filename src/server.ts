import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';
import { registerTools } from './tools/register.js';

export const SERVER_NAME = 'code-atlas';
export const SERVER_VERSION = '0.1.0';

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'code-atlas indexes this workspace with tree-sitter and serves structured code intelligence. ' +
        'Start with project_overview. Use get_file_outline instead of reading whole files, ' +
        'search_symbols to locate definitions, get_symbol_info (include_source=true) to read one ' +
        'definition, and ast_query for structural searches. The index refreshes via reindex.',
    },
  );
  registerTools(server, ctx);
  return server;
}
