import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../context.js';
import type { EdgeKind, SymbolRow } from '../types.js';
import { uncommittedChanges, type ChangedFile } from '../git/diff.js';
import { findSymbol, symbolArgs } from './graph.js';
import { normalizeRel, paginationFooter, text } from './format.js';
import { clampText, maxTokensArg } from './tokens.js';

/** Edge kinds that propagate impact upward: callers, subtypes, overriders. */
const IMPACT_KINDS: EdgeKind[] = ['calls', 'extends', 'implements', 'overrides'];

const PER_NODE_FANIN_CAP = 200;
const VISITED_CAP = 5000;
const FILE_REACH_DEPTH_CAP = 4;
const FILE_REACH_SIZE_CAP = 2000;

interface Seeds {
  symbols: SymbolRow[];
  /** File ids seeding the import-reachability layer (includes deleted-file importers). */
  fileIds: Set<number>;
  summary: string;
  warnings: string[];
}

interface FileImpact {
  path: string;
  isTest: boolean;
  depth: number;
  /** Human route: `calls→name [prov conf]` or `import chain`. */
  via: string;
  seed: boolean;
}

function hunksTouch(sym: SymbolRow, hunks: Array<{ start: number; count: number }>): boolean {
  for (const h of hunks) {
    const end = h.start + Math.max(h.count, 1) - 1;
    if (sym.startLine <= end && sym.endLine >= h.start) return true;
  }
  return false;
}

async function gitSeeds(ctx: AppContext): Promise<Seeds | { error: string }> {
  const res = await uncommittedChanges(ctx.config.root);
  if (!res.ok) {
    return {
      error: `git mode unavailable: ${res.reason} — pass files=[...] or a symbol target instead`,
    };
  }
  if (res.changes.length === 0) return { error: 'working tree is clean — nothing to analyze' };

  const symbols: SymbolRow[] = [];
  const fileIds = new Set<number>();
  const warnings: string[] = [];
  const counted = new Map<ChangedFile['status'], number>();
  let unindexed = 0;
  for (const change of res.changes) {
    counted.set(change.status, (counted.get(change.status) ?? 0) + 1);
    const file = ctx.store.getFileByPath(change.path);
    if (!file) {
      // deleted files legitimately have no row after reindex; other misses are
      // non-code files (configs, docs) or not-yet-indexed additions
      if (change.status !== 'deleted') unindexed++;
      continue;
    }
    fileIds.add(file.id);
    if (change.status === 'deleted') continue; // importers only — no new-side symbols
    const all = ctx.store.symbolsForFile(file.id);
    if (change.hunks && change.hunks.length > 0) {
      symbols.push(...all.filter((s) => hunksTouch(s, change.hunks!)));
    } else {
      symbols.push(...all); // untracked/renamed: whole file
    }
  }
  if (unindexed > 0) {
    warnings.push(`${unindexed} changed file(s) not in the index (non-code or not yet indexed)`);
  }
  const parts = [...counted.entries()].map(([status, n]) => `${n} ${status}`);
  return {
    symbols,
    fileIds,
    summary: `git: ${parts.join(', ')}`,
    warnings,
  };
}

/** Reverse BFS over impact edges; returns reached symbols with depth + route. */
function symbolImpact(
  ctx: AppContext,
  seeds: SymbolRow[],
  maxDepth: number,
  minConfidence: number,
): { reached: Map<number, { sym: SymbolRow; depth: number; via: string }>; truncated: boolean } {
  const reached = new Map<number, { sym: SymbolRow; depth: number; via: string }>();
  const visited = new Set<number>(seeds.map((s) => s.id));
  const queue: Array<{ id: number; name: string; depth: number }> = seeds.map((s) => ({
    id: s.id,
    name: s.name,
    depth: 0,
  }));
  let truncated = false;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    const edges = ctx.store.edgesFor(cur.id, 'in', IMPACT_KINDS);
    let expanded = 0;
    for (const e of edges) {
      if (e.confidence < minConfidence) continue;
      if (expanded >= PER_NODE_FANIN_CAP) {
        truncated = true;
        break;
      }
      expanded++;
      if (visited.has(e.symbolId)) continue;
      if (visited.size >= VISITED_CAP) {
        truncated = true;
        break;
      }
      visited.add(e.symbolId);
      const sym = ctx.store.getSymbolById(e.symbolId);
      if (!sym) continue;
      reached.set(e.symbolId, {
        sym,
        depth: cur.depth + 1,
        via: `${e.edgeKind}→${cur.name} [${e.provenance} ${e.confidence.toFixed(2)}]`,
      });
      queue.push({ id: e.symbolId, name: sym.name, depth: cur.depth + 1 });
    }
  }
  return { reached, truncated };
}

/** Transitive importers of the seed files, to a depth/size cap. */
function fileImpact(ctx: AppContext, seedFileIds: Set<number>): Map<number, number> {
  const depthOf = new Map<number, number>();
  let frontier = new Set(seedFileIds);
  for (let depth = 1; depth <= FILE_REACH_DEPTH_CAP && frontier.size > 0; depth++) {
    const next = new Set<number>();
    for (const id of ctx.store.filesImporting(frontier)) {
      if (seedFileIds.has(id) || depthOf.has(id)) continue;
      depthOf.set(id, depth);
      next.add(id);
      if (depthOf.size >= FILE_REACH_SIZE_CAP) return depthOf;
    }
    frontier = next;
  }
  return depthOf;
}

function staleSeedWarning(
  ctx: AppContext,
  fileIds: Set<number>,
  byId: Map<number, { path: string; hash: string }>,
): string | null {
  let stale = 0;
  for (const id of fileIds) {
    const file = byId.get(id);
    if (!file) continue;
    try {
      const source = readFileSync(join(ctx.config.root, file.path), 'utf8');
      const hash = createHash('sha1').update(source).digest('hex');
      if (hash !== file.hash) stale++;
    } catch {
      // deleted since indexing — the importer-based seeding already covers it
    }
  }
  if (stale === 0) return null;
  return `warning: index stale for ${stale} seed file(s) — results may lag the working tree; call reindex for exact answers`;
}

export function registerImpactTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'change_impact',
    {
      title: 'Change impact',
      description:
        'Blast radius of a change: transitive callers/subtypes of the target plus files reachable ' +
        'through imports, with affected TEST files highlighted. Target a symbol (symbol_id/path+line/name), ' +
        'a set of files (files=[...]), or nothing — no arguments analyzes the uncommitted git diff.',
      inputSchema: {
        ...symbolArgs,
        files: z.array(z.string()).optional().describe('changed files to analyze (workspace-relative)'),
        max_depth: z.number().int().min(1).max(15).default(6),
        min_confidence: z.number().min(0).max(1).default(0.5)
          .describe('ignore call edges below this confidence'),
        tests_only: z.boolean().default(false).describe('report only affected test files'),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
        ...maxTokensArg,
      },
    },
    async (args) => {
      // ---- seeds ----
      let seeds: Seeds;
      if (args.symbol_id !== undefined || args.path !== undefined || args.name !== undefined) {
        const found = findSymbol(ctx, args);
        if (!found.ok) return text(found.message);
        seeds = {
          symbols: [found.sym],
          fileIds: new Set([found.sym.fileId]),
          summary: `1 symbol (${found.sym.kind} ${found.sym.qualifiedName})`,
          warnings: [],
        };
      } else if (args.files && args.files.length > 0) {
        const symbols: SymbolRow[] = [];
        const fileIds = new Set<number>();
        const missing: string[] = [];
        for (const p of args.files) {
          const rel = normalizeRel(ctx, p);
          const file = ctx.store.getFileByPath(rel);
          if (!file) {
            missing.push(rel);
            continue;
          }
          fileIds.add(file.id);
          symbols.push(...ctx.store.symbolsForFile(file.id));
        }
        if (fileIds.size === 0) return text(`none of the given files are indexed: ${missing.join(', ')}`);
        seeds = {
          symbols,
          fileIds,
          summary: `${fileIds.size} file(s), ${symbols.length} symbols`,
          warnings: missing.length > 0 ? [`not indexed: ${missing.join(', ')}`] : [],
        };
      } else {
        const fromGit = await gitSeeds(ctx);
        if ('error' in fromGit) return text(fromGit.error);
        seeds = fromGit;
      }

      // ---- traversal ----
      const { reached, truncated } = symbolImpact(ctx, seeds.symbols, args.max_depth, args.min_confidence);
      const importerDepths = fileImpact(ctx, seeds.fileIds);

      // merge to file granularity, keeping the strongest (min-depth) route per file
      const allFiles = ctx.store.listFiles();
      const byId = new Map(allFiles.map((f) => [f.id, f]));
      const byPath = new Map(allFiles.map((f) => [f.path, f]));
      const files = new Map<string, FileImpact>();
      const seedPaths = new Set<string>();
      for (const id of seeds.fileIds) {
        const f = byId.get(id);
        if (f) seedPaths.add(f.path);
      }
      // impacted handler symbols get their route surfaced on the file line
      const routesBySymbol = ctx.store.routesForSymbols(reached.keys());
      const routeTags = new Map<string, string>();
      for (const { sym, depth, via } of reached.values()) {
        const routes = routesBySymbol.get(sym.id);
        if (routes && !routeTags.has(sym.path)) {
          routeTags.set(sym.path, routes.map((r) => `[ROUTE ${r.method} ${r.path}]`).join(' '));
        }
        const existing = files.get(sym.path);
        if (!existing || depth < existing.depth) {
          files.set(sym.path, {
            path: sym.path,
            isTest: Boolean(byPath.get(sym.path)?.isTest),
            depth,
            via: `${via} at ${sym.qualifiedName}`,
            seed: seedPaths.has(sym.path),
          });
        }
      }
      for (const [fileId, depth] of importerDepths) {
        const rec = byId.get(fileId);
        if (!rec || files.has(rec.path)) continue;
        files.set(rec.path, {
          path: rec.path,
          isTest: Boolean(rec.isTest),
          depth,
          via: 'import chain',
          seed: false,
        });
      }
      for (const path of seedPaths) files.delete(path); // a seed is a cause, not an effect

      // ---- output ----
      let rows = [...files.values()];
      if (args.tests_only) rows = rows.filter((r) => r.isTest);
      rows.sort((a, b) =>
        Number(b.isTest) - Number(a.isTest) || a.depth - b.depth || a.path.localeCompare(b.path),
      );
      const testCount = rows.filter((r) => r.isTest).length;

      const lines: string[] = [];
      lines.push(`seeds: ${seeds.summary}`);
      const stale = staleSeedWarning(ctx, seeds.fileIds, byId);
      if (stale) lines.push(stale);
      for (const w of seeds.warnings) lines.push(`note: ${w}`);
      if (ctx.indexer.progress.state === 'indexing') {
        lines.push('warning: indexing in progress — the graph may be incomplete');
      }
      if (truncated) {
        lines.push(`note: traversal truncated (fan-in cap ${PER_NODE_FANIN_CAP}/node, ${VISITED_CAP} symbols total)`);
      }
      lines.push(
        `impact: ${files.size} file(s) affected (${testCount} TEST) within depth ${args.max_depth}, ` +
          `${reached.size} symbols via call/type edges`,
      );
      lines.push('');
      if (rows.length === 0) {
        lines.push(
          args.tests_only
            ? 'no affected test files found (structural index — dynamic dispatch and fixtures loaded by name are invisible)'
            : 'nothing outside the seed files is affected within the given depth/confidence',
        );
        return text(lines.join('\n'));
      }
      const shown = rows.slice(args.offset, args.offset + args.limit);
      const width = Math.min(60, Math.max(...shown.map((r) => r.path.length)));
      for (const r of shown) {
        const tag = r.isTest ? 'TEST ' : '     ';
        const route = routeTags.get(r.path);
        lines.push(
          `${tag}${r.path.padEnd(width)}  — via ${r.via} (depth ${r.depth})${route ? ` ${route}` : ''}`,
        );
      }
      return text(clampText(
        lines.join('\n') + paginationFooter(shown.length, args.limit, args.offset),
        args.max_tokens,
      ));
    },
  );
}
