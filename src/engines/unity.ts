import type { AssetRefInsert } from '../db/store.js';
import type { AssetKind } from './detect.js';

/**
 * Unity YAML is deliberately parsed line-wise, not with a YAML library:
 * the custom `!u!` tags, `stripped` documents, and multi-document scene
 * files break standard parsers, while everything we need — document
 * boundaries, object names, and guid references — is line-shaped.
 */

const DOC_RE = /^--- !u!(\d+) &(\d+)( stripped)?/;
const NAME_RE = /^\s{2}m_Name: (.*)$/;
const SCRIPT_RE = /^\s*m_Script: \{fileID: -?\d+, guid: ([0-9a-f]{32}), type: \d+\}/;
const GAMEOBJECT_RE = /^\s*m_GameObject: \{fileID: (\d+)\}/;
const SOURCE_PREFAB_RE = /^\s*m_SourcePrefab: \{fileID: \d+, guid: ([0-9a-f]{32}), type: \d+\}/;
const PROP_GUID_RE = /^\s*(\w+):.*\{fileID: -?\d+, guid: ([0-9a-f]{32}), type: [23]\}/;
const META_GUID_RE = /^guid: ([0-9a-f]{32})\s*$/m;

const TAG_GAMEOBJECT = '1';
const TAG_MONOBEHAVIOUR = '114';

/** `X.meta` declares the guid of sibling asset `X`. */
export function extractMetaGuid(relPath: string, source: string): AssetRefInsert[] {
  const guid = META_GUID_RE.exec(source)?.[1];
  if (!guid) return [];
  return [{ targetKind: 'guid_of', target: guid, detail: relPath.replace(/\.meta$/, '') }];
}

export function extractUnityAsset(kind: AssetKind, relPath: string, source: string): AssetRefInsert[] {
  if (kind === 'meta') return extractMetaGuid(relPath, source);

  const lines = source.split('\n');

  // pass 1: GameObject anchor -> name (to label MonoBehaviour refs)
  const goNames = new Map<string, string>();
  let currentTag: string | null = null;
  let currentAnchor: string | null = null;
  for (const line of lines) {
    const doc = DOC_RE.exec(line);
    if (doc) {
      currentTag = doc[1]!;
      currentAnchor = doc[2]!;
      continue;
    }
    if (currentTag === TAG_GAMEOBJECT && currentAnchor) {
      const name = NAME_RE.exec(line);
      if (name) goNames.set(currentAnchor, name[1]!.trim());
    }
  }

  // pass 2: refs
  const refs: AssetRefInsert[] = [];
  const seen = new Set<string>();
  const push = (targetKind: string, target: string, detail: string | null): void => {
    const key = `${targetKind}:${target}:${detail ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ targetKind, target, detail });
  };

  currentTag = null;
  let currentGo: string | null = null;
  let currentScriptGuid: string | null = null;
  const flushMono = (): void => {
    if (currentScriptGuid) {
      push('script', currentScriptGuid, currentGo ? (goNames.get(currentGo) ?? null) : null);
    }
    currentGo = null;
    currentScriptGuid = null;
  };

  for (const line of lines) {
    const doc = DOC_RE.exec(line);
    if (doc) {
      flushMono();
      currentTag = doc[1]!;
      continue;
    }
    if (currentTag === TAG_MONOBEHAVIOUR) {
      const go = GAMEOBJECT_RE.exec(line);
      if (go) {
        currentGo = go[1]!;
        continue;
      }
      const script = SCRIPT_RE.exec(line);
      if (script) {
        currentScriptGuid = script[1]!;
        continue;
      }
    }
    const prefab = SOURCE_PREFAB_RE.exec(line);
    if (prefab) {
      push('prefab', prefab[1]!, null);
      continue;
    }
    const prop = PROP_GUID_RE.exec(line);
    if (prop && prop[1] !== 'm_Script' && prop[1] !== 'm_SourcePrefab') {
      push('asset', prop[2]!, prop[1]!);
    }
  }
  flushMono();
  return refs;
}
