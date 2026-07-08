export type EngineId = 'godot' | 'unity' | 'unreal';

export type AssetKind =
  | 'scene'        // godot .tscn
  | 'resource'     // godot .tres
  | 'project'      // project.godot
  | 'prefab'       // unity .prefab
  | 'unity_scene'  // unity .unity
  | 'unity_asset'  // unity .asset (ScriptableObject etc.)
  | 'meta'         // unity .meta (guid map)
  | 'uproject'
  | 'uplugin'
  | 'buildcs';     // unreal Module.Build.cs

export interface AssetInfo {
  kind: AssetKind;
  engine: EngineId;
}

/**
 * Engine asset classification by filename. (*.Build.cs files also index as
 * C# source — the asset layer additionally reads their module dependencies.)
 */
export function assetForPath(path: string): AssetInfo | undefined {
  const base = path.split('/').pop()!.toLowerCase();
  if (base === 'project.godot') return { kind: 'project', engine: 'godot' };
  if (base.endsWith('.build.cs')) return { kind: 'buildcs', engine: 'unreal' };
  const dot = base.lastIndexOf('.');
  if (dot === -1) return undefined;
  switch (base.slice(dot)) {
    case '.tscn': return { kind: 'scene', engine: 'godot' };
    case '.tres': return { kind: 'resource', engine: 'godot' };
    case '.unity': return { kind: 'unity_scene', engine: 'unity' };
    case '.prefab': return { kind: 'prefab', engine: 'unity' };
    case '.asset': return { kind: 'unity_asset', engine: 'unity' };
    case '.meta': return { kind: 'meta', engine: 'unity' };
    case '.uproject': return { kind: 'uproject', engine: 'unreal' };
    case '.uplugin': return { kind: 'uplugin', engine: 'unreal' };
    default: return undefined;
  }
}
