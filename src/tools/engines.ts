import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { assetForPath } from '../engines/detect.js';
import { parseScene, type SceneNode } from '../engines/godot.js';

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

/** Depth of a node from its `parent` attribute ('' root, '.' root child, 'A/B' deeper). */
function depthOf(node: SceneNode): number {
  if (node.parent === null || node.parent === '') return 0;
  if (node.parent === '.') return 1;
  return node.parent.split('/').length + 1;
}

/** Locate a gdscript symbol by exact name for handler annotations. */
function findHandler(ctx: AppContext, method: string): string | null {
  const rows = ctx.store
    .searchSymbols(method, { limit: 5, offset: 0 })
    .filter((r) => r.name === method && r.lang === 'gdscript');
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return `${r.path}:${r.startLine} #${r.id}${rows.length > 1 ? ` (+${rows.length - 1} more)` : ''}`;
}

export function registerEngineTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'get_scene_structure',
    {
      title: 'Scene structure',
      description:
        'Node tree of a game-engine scene file with attached scripts, instanced sub-scenes, and ' +
        'signal connections. Supports Godot .tscn/.tres today (Unity prefabs planned).',
      inputSchema: {
        path: z.string().describe('scene file path, relative to the workspace root'),
      },
    },
    async (args) => {
      const rel = normalizeRel(ctx, args.path);
      const info = assetForPath(rel);
      if (!info) return text(`not a recognized engine asset: ${rel}`);
      if (info.engine !== 'godot') return text(`${info.engine} scene parsing lands in a later wave`);

      let source: string;
      try {
        source = readFileSync(join(ctx.config.root, rel), 'utf8');
      } catch {
        return text(`cannot read ${rel}`);
      }
      const scene = parseScene(source);
      if (scene.nodes.length === 0) return text(`${rel}: no nodes (not a scene?)`);

      const lines = [`${rel} (godot ${info.kind}, ${scene.nodes.length} nodes)`];
      for (const node of scene.nodes) {
        const indent = '  '.repeat(depthOf(node));
        const type = node.type ? ` (${node.type})` : '';
        const script = node.scriptPath ? `  script=${node.scriptPath}` : '';
        const inst = node.instancePath ? `  [instance: ${node.instancePath}]` : '';
        lines.push(`${indent}${node.name}${type}${script}${inst}`);
      }
      if (scene.connections.length > 0) {
        lines.push('', 'connections:');
        for (const c of scene.connections) {
          const handler = findHandler(ctx, c.method);
          lines.push(
            `  ${c.signal}: ${c.from || '.'} -> ${c.to || '.'} :: ${c.method}` +
              (handler ? `  (${handler})` : ''),
          );
        }
      }
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'find_asset_references',
    {
      title: 'Find asset references',
      description:
        'Reverse lookup across engine assets: which scenes/prefabs/resources reference this script, ' +
        'scene, resource path, or handler method? Accepts a workspace-relative path, a res:// path, ' +
        'or a bare method/class name.',
      inputSchema: {
        target: z.string().describe('e.g. "player.gd", "res://player.gd", or "_on_body_entered"'),
      },
    },
    async (args) => {
      const raw = args.target;
      const rel = normalizeRel(ctx, raw);
      // variant -> project-root prefix a matching asset must live under ('' = anywhere)
      const variants = new Map<string, string>([
        [raw, ''],
        [rel, ''],
      ]);
      if (!raw.includes('://')) {
        variants.set(`res://${rel}`, '');
        // in multi-project workspaces res:// is relative to each project.godot dir
        for (const asset of ctx.store.listAssets()) {
          if (asset.kind !== 'project') continue;
          const root = asset.path.replace(/\/?project\.godot$/, '');
          if (root !== '' && rel.startsWith(`${root}/`)) {
            variants.set(`res://${rel.slice(root.length + 1)}`, root);
          }
        }
      }
      const guid = ctx.store.guidForPath(rel);
      if (guid) variants.set(guid, '');

      const rows = ctx.store
        .assetsReferencing([...variants.keys()])
        .filter((r) => {
          const requiredRoot = variants.get(r.target);
          return !requiredRoot || r.path.startsWith(`${requiredRoot}/`);
        });
      if (rows.length === 0) {
        return text(`no asset references ${raw} (checked: ${[...variants.keys()].join(', ')})`);
      }
      const lines = rows.map((r) => {
        // unity targets are guids — show the file they resolve to
        const resolved = /^[0-9a-f]{32}$/.test(r.target) ? ctx.store.pathForGuid(r.target) : null;
        const target = resolved ? `${resolved} (guid ${r.target.slice(0, 8)}…)` : r.target;
        return `${r.path} (${r.engine} ${r.kind})  ${r.targetKind}: ${target}${r.detail ? `  — ${r.detail}` : ''}`;
      });
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'search_reflection',
    {
      title: 'Search engine reflection markers',
      description:
        'Find engine-reflected declarations: Unreal UCLASS/UPROPERTY/UFUNCTION specifiers ' +
        '(e.g. "BlueprintCallable", "Replicated"), Unity attributes ("[SerializeField]"), and Godot ' +
        'annotations ("@export", "@onready") or signals. Searches indexed C++ headers on demand and ' +
        'declaration signatures in the index.',
      inputSchema: {
        specifier: z
          .string()
          .min(2)
          .describe('marker to search: "BlueprintCallable", "UPROPERTY", "[SerializeField]", "@export", "signal"'),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async (args) => {
      const spec = args.specifier;
      const lines: string[] = [];

      // Godot: signals are first-class symbols; annotations live in signatures
      if (spec.toLowerCase() === 'signal') {
        for (const s of ctx.store.searchSymbols('', { kind: 'signal', limit: args.limit, offset: 0 })) {
          lines.push(`${s.path}:${s.startLine}  ${s.signature ?? s.name} #${s.id}`);
        }
      }
      for (const s of ctx.store.symbolsWithSignatureLike(spec, undefined, args.limit)) {
        if (lines.length >= args.limit) break;
        lines.push(`${s.path}:${s.startLine}  [${s.lang}] ${s.kind} ${s.qualifiedName}: ${s.signature} #${s.id}`);
      }

      // Unreal: reflection macros sit above declarations — scan indexed headers
      const macroRe = /^\s*(UCLASS|USTRUCT|UENUM|UINTERFACE|UPROPERTY|UFUNCTION|UDELEGATE)\s*\(([^)]*)\)/;
      const wantMacro = /^U[A-Z]+$/.test(spec);
      const headers = ctx.store
        .listFiles()
        .filter((f) => (f.lang === 'cpp' || f.lang === 'c') && /\.(h|hpp|hxx)$/.test(f.path));
      for (const file of headers) {
        if (lines.length >= args.limit) break;
        let source: string;
        try {
          source = readFileSync(join(ctx.config.root, file.path), 'utf8');
        } catch {
          continue;
        }
        if (!source.includes(wantMacro ? spec : spec.replace(/^"|"$/g, ''))) continue;
        const fileLines = source.split('\n');
        for (let i = 0; i < fileLines.length && lines.length < args.limit; i++) {
          const m = macroRe.exec(fileLines[i]!);
          if (!m) continue;
          const matches = wantMacro
            ? m[1] === spec
            : m[2]!.toLowerCase().includes(spec.toLowerCase());
          if (!matches) continue;
          // the declaration follows the macro line
          const decl = fileLines
            .slice(i + 1, i + 3)
            .map((l) => l.trim())
            .find((l) => l.length > 0 && !macroRe.test(l));
          lines.push(`${file.path}:${i + 1}  ${m[1]}(${m[2]!.trim()})  ${decl ?? ''}`.trimEnd());
        }
      }

      if (lines.length === 0) return text(`no reflection markers matching "${spec}"`);
      const footer = lines.length >= args.limit ? `\n(hit limit=${args.limit})` : '';
      return text(lines.join('\n') + footer);
    },
  );
}
