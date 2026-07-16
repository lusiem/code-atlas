import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { EdgeKind } from '../types.js';
import { emptyGraphNote, text } from './format.js';
import { CALL_KINDS, TYPE_KINDS, findSymbol, shortestCallPath, symbolArgs } from './graph.js';
import { clampToBudget, maxTokensArg } from './tokens.js';

function fence(
  header: string,
  body: string[],
  note?: string,
  maxTokens?: number,
): ReturnType<typeof text> {
  // clamp whole diagram lines only — node declarations precede edges in every
  // renderer, so a cut from the end drops edges, never dangling references
  let shownBody = body;
  if (maxTokens !== undefined) {
    const clamped = clampToBudget(body, maxTokens);
    if (clamped.omittedLines > 0) {
      shownBody = clamped.text.split('\n');
      const cut = `(diagram truncated: ${clamped.omittedLines} lines over max_tokens=${maxTokens} — lower depth/max_nodes or raise max_tokens)`;
      note = note ? `${note}\n${cut}` : cut;
    }
  }
  const parts = [header, '', '```mermaid', ...shownBody, '```'];
  if (note) parts.push('', note);
  return text(parts.join('\n'));
}

/** Mermaid quoted-label safe: no double quotes, no raw line breaks. */
function esc(label: string): string {
  return label.replace(/"/g, "'").replace(/\r?\n/g, ' ');
}

function decl(id: string, label: string): string {
  return `${id}["${esc(label)}"]`;
}

/** Assigns short sequential node ids (n0, n1, …) keyed by any string. */
class NodeIds {
  private ids = new Map<string, string>();

  id(key: string): string {
    let id = this.ids.get(key);
    if (!id) {
      id = `n${this.ids.size}`;
      this.ids.set(key, id);
    }
    return id;
  }

  has(key: string): boolean {
    return this.ids.has(key);
  }

  get size(): number {
    return this.ids.size;
  }
}

/** Confidence < 0.7 renders dotted — the same "treat as hint" line the text tools draw. */
function arrow(confidence: number, label?: string): string {
  const tag = label ? `|${label}|` : '';
  return confidence < 0.7 ? `-.->${tag}` : `-->${tag}`;
}

interface CollectedEdge {
  srcId: number;
  dstId: number;
  kind: EdgeKind;
  confidence: number;
}

interface NodeLabel {
  name: string;
  at: string; // path:line, appended only when two nodes would otherwise look identical
}

/**
 * BFS from a root symbol over graph edges, expanding in one or both directions.
 * Edges keep their stored orientation (caller->callee, subtype->supertype)
 * regardless of which direction the walk expanded.
 */
function collectGraph(
  ctx: AppContext,
  rootId: number,
  directions: Array<'in' | 'out'>,
  kinds: EdgeKind[],
  maxDepth: number,
  maxNodes: number,
): { labels: Map<number, NodeLabel>; edges: CollectedEdge[]; truncated: boolean } {
  const labels = new Map<number, NodeLabel>();
  const edges: CollectedEdge[] = [];
  const seenEdges = new Set<string>();
  let truncated = false;

  const root = ctx.store.getSymbolById(rootId);
  labels.set(
    rootId,
    root
      ? { name: root.qualifiedName, at: `${root.path}:${root.startLine}` }
      : { name: `#${rootId}`, at: '' },
  );

  let frontier = [rootId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const direction of directions) {
        for (const e of ctx.store.edgesFor(id, direction, kinds)) {
          const [srcId, dstId] = direction === 'out' ? [id, e.symbolId] : [e.symbolId, id];
          const edgeKey = `${srcId}>${dstId}>${e.edgeKind}`;
          if (seenEdges.has(edgeKey)) continue;
          const isNewNode = !labels.has(e.symbolId);
          if (isNewNode && labels.size >= maxNodes) {
            truncated = true;
            continue;
          }
          seenEdges.add(edgeKey);
          edges.push({ srcId, dstId, kind: e.edgeKind, confidence: e.confidence });
          if (isNewNode) {
            labels.set(e.symbolId, { name: e.qualifiedName, at: `${e.path}:${e.startLine}` });
            next.push(e.symbolId);
          }
        }
      }
    }
    frontier = next;
  }
  return { labels, edges, truncated };
}

function renderSymbolGraph(
  orientation: 'LR' | 'BT',
  rootId: number,
  labels: Map<number, NodeLabel>,
  edges: CollectedEdge[],
  labelEdgeKinds: boolean,
): string[] {
  const nameCounts = new Map<string, number>();
  for (const l of labels.values()) nameCounts.set(l.name, (nameCounts.get(l.name) ?? 0) + 1);
  const nodes = new NodeIds();
  const lines = [`flowchart ${orientation}`];
  for (const [id, l] of labels) {
    const label = (nameCounts.get(l.name) ?? 0) > 1 && l.at ? `${l.name}<br/>${l.at}` : l.name;
    lines.push(`  ${decl(nodes.id(String(id)), label)}`);
  }
  for (const e of edges) {
    const label = labelEdgeKinds ? e.kind : undefined;
    lines.push(`  ${nodes.id(String(e.srcId))} ${arrow(e.confidence, label)} ${nodes.id(String(e.dstId))}`);
  }
  lines.push(`  classDef focus stroke-width:3px`);
  lines.push(`  class ${nodes.id(String(rootId))} focus`);
  return lines;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function renderImports(
  ctx: AppContext,
  pathPrefix: string | null,
  granularity: 'auto' | 'file' | 'dir',
  maxNodes: number,
  maxTokens: number,
): ReturnType<typeof text> {
  let pairs = ctx.store.importPairs();
  if (pathPrefix) {
    pairs = pairs.filter((p) => p.src.startsWith(pathPrefix) && p.dst.startsWith(pathPrefix));
  }
  const scope = pathPrefix ? ` under ${pathPrefix}` : '';
  if (pairs.length === 0) {
    return text(`no workspace-internal imports${scope} (external packages are not drawn)`);
  }

  const filesInvolved = new Set<string>();
  for (const p of pairs) {
    filesInvolved.add(p.src);
    filesInvolved.add(p.dst);
  }
  const useDirs = granularity === 'dir' || (granularity === 'auto' && filesInvolved.size > maxNodes);
  if (useDirs) return renderImportsByDir(pairs, scope, maxNodes, maxTokens);

  // file level: one node per file, clustered into a subgraph per directory
  const byDir = new Map<string, string[]>();
  let truncated = false;
  let kept = 0;
  for (const f of [...filesInvolved].sort()) {
    if (kept >= maxNodes) {
      truncated = true;
      break;
    }
    kept++;
    const dir = dirOf(f);
    const list = byDir.get(dir) ?? [];
    list.push(f);
    byDir.set(dir, list);
  }

  const nodes = new NodeIds();
  const lines = ['flowchart LR'];
  let cluster = 0;
  for (const [dir, files] of byDir) {
    if (dir !== '') lines.push(`  subgraph d${cluster++}["${esc(dir)}"]`);
    const indent = dir === '' ? '  ' : '    ';
    for (const f of files) {
      lines.push(`${indent}${decl(nodes.id(f), f.slice(dir === '' ? 0 : dir.length + 1))}`);
    }
    if (dir !== '') lines.push('  end');
  }
  for (const p of pairs) {
    if (nodes.has(p.src) && nodes.has(p.dst)) lines.push(`  ${nodes.id(p.src)} --> ${nodes.id(p.dst)}`);
  }
  const note = truncated
    ? `(truncated at max_nodes=${maxNodes} files — narrow with path_prefix, or use granularity=dir for the full picture)`
    : undefined;
  return fence(`import graph${scope}, file level:`, lines, note, maxTokens);
}

function renderImportsByDir(
  pairs: Array<{ src: string; dst: string }>,
  scope: string,
  maxNodes: number,
  maxTokens: number,
): ReturnType<typeof text> {
  // collapse to directory level, weighting edges by distinct file pairs
  const weights = new Map<string, { src: string; dst: string; n: number }>();
  for (const p of pairs) {
    const src = dirOf(p.src) || '(root)';
    const dst = dirOf(p.dst) || '(root)';
    if (src === dst) continue;
    const key = `${src} -> ${dst}`;
    const cur = weights.get(key);
    if (cur) cur.n++;
    else weights.set(key, { src, dst, n: 1 });
  }
  if (weights.size === 0) {
    return text(
      `all imports${scope} stay within a single directory — nothing to draw at dir granularity; retry with granularity=file`,
    );
  }
  const nodes = new NodeIds();
  const declLines: string[] = [];
  const edgeLines: string[] = [];
  let truncated = false;
  for (const { src, dst, n } of weights.values()) {
    for (const d of [src, dst]) {
      if (!nodes.has(d)) {
        if (nodes.size >= maxNodes) {
          truncated = true;
        } else {
          declLines.push(`  ${decl(nodes.id(d), d)}`);
        }
      }
    }
    if (nodes.has(src) && nodes.has(dst)) {
      edgeLines.push(`  ${nodes.id(src)} -->|${n}| ${nodes.id(dst)}`);
    }
  }
  const note = truncated
    ? `(truncated at max_nodes=${maxNodes} directories — narrow with path_prefix or raise max_nodes)`
    : undefined;
  return fence(
    `import graph${scope}, directory level (edge label = number of file-to-file imports):`,
    ['flowchart LR', ...declLines, ...edgeLines],
    note,
    maxTokens,
  );
}

export function registerDiagramTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'generate_diagram',
    {
      title: 'Generate Mermaid diagram',
      description:
        'Render index data as a Mermaid diagram (returned in a ```mermaid fence — paste into GitHub ' +
        'markdown, docs, or a Mermaid viewer). kind=imports: workspace import graph, file-level with ' +
        'directory clusters or collapsed to directories (granularity, path_prefix to scope). ' +
        'kind=calls: call graph around one symbol (direction in/out/both, depth). kind=types: ' +
        'inheritance diagram around one type. kind=call_path: shortest call chain from one symbol to ' +
        'another (from_name/from_id -> to_name/to_id). Dotted arrows are low-confidence structural ' +
        'edges (< 0.70) — hints, not facts.',
      inputSchema: {
        kind: z.enum(['imports', 'calls', 'types', 'call_path']),
        // imports
        path_prefix: z.string().optional().describe('imports: only files under this root-relative path'),
        granularity: z
          .enum(['auto', 'file', 'dir'])
          .default('auto')
          .describe('imports: file-level, directory-level, or auto (dir when the file graph exceeds max_nodes)'),
        // calls / types target
        ...symbolArgs,
        direction: z
          .enum(['in', 'out', 'both'])
          .default('both')
          .describe('calls: callers, callees, or both. types: subtypes, supertypes, or both.'),
        depth: z.number().int().min(1).max(4).default(2).describe('calls/types: levels to expand from the symbol'),
        // call_path
        from_id: z.number().int().optional(),
        from_name: z.string().optional(),
        to_id: z.number().int().optional(),
        to_name: z.string().optional(),
        max_depth: z.number().int().min(1).max(10).default(6).describe('call_path: maximum hops'),
        max_nodes: z.number().int().min(10).max(300).default(80),
        ...maxTokensArg,
      },
    },
    async (args) => {
      switch (args.kind) {
        case 'imports':
          return renderImports(
            ctx,
            args.path_prefix ? args.path_prefix.replace(/\\/g, '/').replace(/^\.\//, '') : null,
            args.granularity,
            args.max_nodes,
            args.max_tokens,
          );

        case 'calls':
        case 'types': {
          const found = findSymbol(ctx, args);
          if (!found.ok) return text(found.message);
          const sym = found.sym;
          const isCalls = args.kind === 'calls';
          // for types, 'in' edges point at subtypes and 'out' at supertypes
          const directions: Array<'in' | 'out'> =
            args.direction === 'both' ? ['in', 'out'] : [args.direction];
          const { labels, edges, truncated } = collectGraph(
            ctx,
            sym.id,
            directions,
            isCalls ? CALL_KINDS : TYPE_KINDS,
            args.depth,
            args.max_nodes,
          );
          if (edges.length === 0) {
            return text(emptyGraphNote(sym, isCalls ? 'calls' : 'types', args.direction));
          }
          const header = isCalls
            ? `call graph around ${sym.kind} ${sym.qualifiedName} (${sym.path}:${sym.startLine}), arrows caller -> callee:`
            : `type hierarchy around ${sym.kind} ${sym.qualifiedName} (${sym.path}:${sym.startLine}), arrows subtype -> supertype:`;
          const body = renderSymbolGraph(isCalls ? 'LR' : 'BT', sym.id, labels, edges, !isCalls);
          const note = truncated
            ? `(truncated at max_nodes=${args.max_nodes} — lower depth or raise max_nodes)`
            : undefined;
          return fence(header, body, note, args.max_tokens);
        }

        case 'call_path': {
          const from = findSymbol(ctx, { symbol_id: args.from_id, name: args.from_name }, 'from_');
          if (!from.ok) return text(from.message);
          const to = findSymbol(ctx, { symbol_id: args.to_id, name: args.to_name }, 'to_');
          if (!to.ok) return text(to.message);
          const chain = shortestCallPath(ctx, from.sym.id, to.sym.id, args.max_depth);
          if (!chain) {
            return text(
              `no call path from ${from.sym.qualifiedName} to ${to.sym.qualifiedName} within depth ${args.max_depth} (structural index only — indirect/dynamic calls may be missing)`,
            );
          }
          const nodes = new NodeIds();
          const lines = ['flowchart LR'];
          for (const id of chain) {
            const s = ctx.store.getSymbolById(id);
            const label = s ? `${s.qualifiedName}<br/>${s.path}:${s.startLine}` : `#${id}`;
            lines.push(`  ${decl(nodes.id(String(id)), label)}`);
          }
          for (let i = 1; i < chain.length; i++) {
            lines.push(`  ${nodes.id(String(chain[i - 1]))} --> ${nodes.id(String(chain[i]))}`);
          }
          return fence(
            `call path ${from.sym.qualifiedName} -> ${to.sym.qualifiedName} (${chain.length - 1} hops):`,
            lines,
            undefined,
            args.max_tokens,
          );
        }
      }
    },
  );
}
