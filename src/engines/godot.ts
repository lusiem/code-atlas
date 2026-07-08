import type { AssetRefInsert } from '../db/store.js';
import type { AssetKind } from './detect.js';

/**
 * Godot text formats (.tscn/.tres/project.godot) are INI-like: section
 * headers `[node name="X" type="Y" ...]` followed by `key = value` lines.
 * Same shape in Godot 3 and 4; only attribute spellings differ slightly.
 */

export interface SceneNode {
  name: string;
  type: string | null;
  /** Parent node path as written ('' for the root node, '.' for root children). */
  parent: string | null;
  /** res:// path of the attached script, if any. */
  scriptPath: string | null;
  /** res:// path of the instanced scene, if any. */
  instancePath: string | null;
}

export interface SceneConnection {
  signal: string;
  from: string;
  to: string;
  method: string;
}

export interface ParsedScene {
  /** ext_resource id -> { type, path } */
  extResources: Map<string, { type: string; path: string }>;
  nodes: SceneNode[];
  connections: SceneConnection[];
}

const SECTION_RE = /^\[(\w+)(?:\s+(.*))?\]\s*$/;
const ATTR_RE = /(\w+)=("(?:[^"\\]|\\.)*"|[^\s\]]+)/g;
const EXT_RESOURCE_RE = /ExtResource\(\s*"?([^)"]+?)"?\s*\)/;

function unquote(v: string): string {
  return v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v;
}

function parseAttrs(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const m of text.matchAll(ATTR_RE)) out[m[1]!] = unquote(m[2]!);
  return out;
}

export function parseScene(source: string): ParsedScene {
  const extResources = new Map<string, { type: string; path: string }>();
  const nodes: SceneNode[] = [];
  const connections: SceneConnection[] = [];
  let currentNode: SceneNode | null = null;

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    const section = SECTION_RE.exec(line);
    if (section) {
      currentNode = null;
      const attrs = parseAttrs(section[2]);
      switch (section[1]) {
        case 'ext_resource':
          if (attrs.id !== undefined && attrs.path) {
            extResources.set(attrs.id, { type: attrs.type ?? '', path: attrs.path });
          }
          break;
        case 'node': {
          const instanceExt = attrs.instance ? EXT_RESOURCE_RE.exec(attrs.instance)?.[1] : null;
          currentNode = {
            name: attrs.name ?? '',
            type: attrs.type ?? null,
            parent: attrs.parent ?? (nodes.length === 0 ? '' : null),
            scriptPath: null,
            instancePath: instanceExt ? (extResources.get(instanceExt)?.path ?? null) : null,
          };
          nodes.push(currentNode);
          break;
        }
        case 'connection':
          if (attrs.signal && attrs.method) {
            connections.push({
              signal: attrs.signal,
              from: attrs.from ?? '',
              to: attrs.to ?? '',
              method: attrs.method,
            });
          }
          break;
      }
      continue;
    }
    if (currentNode) {
      const prop = /^script\s*=\s*(.+)$/.exec(line);
      if (prop) {
        const ext = EXT_RESOURCE_RE.exec(prop[1]!)?.[1];
        if (ext) currentNode.scriptPath = extResources.get(ext)?.path ?? null;
      }
    }
  }
  return { extResources, nodes, connections };
}

/** Full path of a node inside its scene, e.g. `Player/Sprite`. */
export function nodePath(node: SceneNode, all: SceneNode[]): string {
  const rootName = all[0]?.name ?? '';
  if (node.parent === null || node.parent === '') return node.name;
  if (node.parent === '.') return `${rootName}/${node.name}`.replace(/^\//, '');
  return `${rootName}/${node.parent}/${node.name}`;
}

/** `[autoload]` entries of project.godot: Name="*res://path.gd". */
export function parseAutoloads(source: string): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  let inAutoload = false;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inAutoload = line === '[autoload]';
      continue;
    }
    if (!inAutoload) continue;
    const m = /^(\w+)\s*=\s*"(\*?)(.+)"$/.exec(line);
    if (m) out.push({ name: m[1]!, path: m[3]! });
  }
  return out;
}

export function extractGodotAsset(kind: AssetKind, source: string): AssetRefInsert[] {
  if (kind === 'project') {
    return parseAutoloads(source).map((a) => ({
      targetKind: 'autoload',
      target: a.path,
      detail: a.name,
    }));
  }

  // scene / resource
  const parsed = parseScene(source);
  const refs: AssetRefInsert[] = [];
  const seen = new Set<string>();
  for (const node of parsed.nodes) {
    if (node.scriptPath) {
      refs.push({ targetKind: 'script', target: node.scriptPath, detail: nodePath(node, parsed.nodes) });
    }
    if (node.instancePath) {
      refs.push({ targetKind: 'scene', target: node.instancePath, detail: nodePath(node, parsed.nodes) });
    }
  }
  // ext_resources not attached to a node (textures, other resources, scripts in .tres)
  for (const [, res] of parsed.extResources) {
    const key = `${res.type}:${res.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (refs.some((r) => r.target === res.path)) continue;
    const targetKind = res.type === 'Script' ? 'script' : res.type === 'PackedScene' ? 'scene' : 'resource';
    refs.push({ targetKind, target: res.path, detail: null });
  }
  for (const conn of parsed.connections) {
    refs.push({
      targetKind: 'signal_handler',
      target: conn.method,
      detail: `signal ${conn.signal} from ${conn.from} to ${conn.to}`,
    });
  }
  return refs;
}
