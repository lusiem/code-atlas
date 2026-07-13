import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { RouteRow } from '../types.js';
import { formatSymbolLine, paginationFooter } from './format.js';

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

const FRAMEWORK_VALUES = ['express', 'fastify', 'nestjs', 'fastapi', 'flask', 'django'] as const;

function routeLine(ctx: AppContext, r: RouteRow): string {
  const shown = r.fullPath ?? r.path;
  let handler: string;
  if (r.handlerSymbolId !== null) {
    const sym = ctx.store.getSymbolById(r.handlerSymbolId);
    handler = sym ? formatSymbolLine(sym) : `#${r.handlerSymbolId}`;
  } else if (r.handlerName) {
    handler = `"${r.handlerName}" (unresolved)  (${r.filePath}:${r.startLine})`;
  } else {
    handler = `(inline handler)  (${r.filePath}:${r.startLine})`;
  }
  return `${r.method.padEnd(6)} ${shown}  →  ${handler}`;
}

/** Route pattern -> regex: `:id` / `{id}` / `<int:pk>` segments become wildcards. */
export function routePattern(pattern: string): RegExp {
  const norm = ('/' + pattern).replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
  const parts = norm.split('/').map((seg) => {
    if (seg.startsWith(':') || (seg.startsWith('{') && seg.endsWith('}'))) return '[^/]+';
    if (seg.startsWith('<') && seg.endsWith('>')) return '[^/]+';
    if (seg.includes('*')) return '.*';
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${parts.join('/')}/?$`);
}

/** Static (non-parameter) segment count — more static = more specific match. */
function staticSegments(pattern: string): number {
  return pattern
    .split('/')
    .filter((s) => s && !s.startsWith(':') && !s.startsWith('{') && !s.startsWith('<') && !s.includes('*'))
    .length;
}

export function registerFrameworkTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_routes',
    {
      title: 'List routes',
      description:
        'Web-framework routes indexed across the workspace (Express, Fastify, NestJS, FastAPI, Flask, ' +
        'Django), one line per route with its handler symbol. Filter by framework, HTTP method, or a ' +
        'path fragment.',
      inputSchema: {
        framework: z.enum(FRAMEWORK_VALUES).optional(),
        method: z.string().optional().describe('HTTP verb, e.g. GET'),
        path_contains: z.string().optional().describe('substring of the route path'),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
      },
    },
    async (args) => {
      const rows = ctx.store.listRoutes({
        framework: args.framework,
        method: args.method,
        pathContains: args.path_contains,
        limit: args.limit,
        offset: args.offset,
      });
      if (rows.length === 0) {
        const total = ctx.store.routeStats();
        if (total.length === 0) {
          return text(
            'no routes indexed — the workspace has no files importing a supported framework ' +
              '(express, fastify, @nestjs/*, fastapi, flask, django urls.py)',
          );
        }
        return text('no routes match the given filters');
      }
      const lines = rows.map((r) => routeLine(ctx, r));
      return text(lines.join('\n') + paginationFooter(rows.length, args.limit, args.offset));
    },
  );

  server.registerTool(
    'find_route',
    {
      title: 'Find route',
      description:
        'Which code serves this URL? Matches a concrete request path (e.g. "/api/users/7") against ' +
        'indexed route patterns, parameter segments (:id, {id}, <int:pk>) treated as wildcards. ' +
        'Returns the handler symbol (#id chains into call_hierarchy / change_impact).',
      inputSchema: {
        url: z.string().min(1).describe('request path, optionally prefixed with a verb: "GET /users/7"'),
      },
    },
    async (args) => {
      let method: string | null = null;
      let path = args.url.trim();
      const m = /^([A-Za-z]+)\s+(.+)$/.exec(path);
      if (m && m[2]!.includes('/')) {
        method = m[1]!.toUpperCase();
        path = m[2]!;
      }
      path = ('/' + path).replace(/\/+/g, '/');

      const all = ctx.store.listRoutes({ limit: 10000, offset: 0 });
      const hits = all
        .filter((r) => {
          if (method && r.method !== 'ANY' && r.method !== 'USE' && r.method !== method) return false;
          const pattern = r.fullPath ?? r.path;
          return routePattern(pattern).test(path);
        })
        .sort((a, b) => staticSegments(b.fullPath ?? b.path) - staticSegments(a.fullPath ?? a.path));
      if (hits.length === 0) {
        const total = all.length;
        return text(
          total === 0
            ? 'no routes indexed in this workspace'
            : `no route matches ${method ? `${method} ` : ''}${path} — mounted-router prefixes are not joined across files; try list_routes path_contains with a path segment`,
        );
      }
      const lines = hits.slice(0, 10).map((r) => routeLine(ctx, r));
      if (hits.length > 10) lines.push(`(+${hits.length - 10} more matches)`);
      return text(lines.join('\n'));
    },
  );
}
