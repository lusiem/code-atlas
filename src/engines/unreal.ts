import type { AssetRefInsert } from '../db/store.js';
import type { AssetKind } from './detect.js';

/**
 * Unreal wave 1: the module dependency graph. .uproject/.uplugin are JSON
 * (module + plugin lists); *.Build.cs declares module deps in AddRange calls.
 * Reflection macros (UCLASS/UPROPERTY/…) are served by search_reflection,
 * which scans indexed C++ headers on demand.
 */

const ADDRANGE_RE =
  /(Public|Private)DependencyModuleNames\s*\.\s*AddRange\s*\(\s*new\s+string\[\]\s*\{([^}]*)\}/g;
const ADD_SINGLE_RE = /(Public|Private)DependencyModuleNames\s*\.\s*Add\s*\(\s*"([^"]+)"/g;
const STRING_RE = /"([^"]+)"/g;

export function extractUnrealAsset(kind: AssetKind, source: string): AssetRefInsert[] {
  if (kind === 'uproject' || kind === 'uplugin') {
    try {
      const json = JSON.parse(source) as {
        Modules?: Array<{ Name?: string; Type?: string }>;
        Plugins?: Array<{ Name?: string; Enabled?: boolean }>;
      };
      const refs: AssetRefInsert[] = [];
      for (const m of json.Modules ?? []) {
        if (m.Name) refs.push({ targetKind: 'module', target: m.Name, detail: m.Type ?? null });
      }
      for (const p of json.Plugins ?? []) {
        if (p.Name && p.Enabled !== false) {
          refs.push({ targetKind: 'plugin', target: p.Name, detail: null });
        }
      }
      return refs;
    } catch {
      return [];
    }
  }

  // buildcs: module dependency declarations
  const refs: AssetRefInsert[] = [];
  const seen = new Set<string>();
  for (const block of source.matchAll(ADDRANGE_RE)) {
    const visibility = block[1]!.toLowerCase();
    for (const s of block[2]!.matchAll(STRING_RE)) {
      const key = `${s[1]}:${visibility}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ targetKind: 'module', target: s[1]!, detail: visibility });
      }
    }
  }
  for (const single of source.matchAll(ADD_SINGLE_RE)) {
    const key = `${single[2]}:${single[1]!.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ targetKind: 'module', target: single[2]!, detail: single[1]!.toLowerCase() });
    }
  }
  return refs;
}
