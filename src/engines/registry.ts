import type { AssetRefInsert } from '../db/store.js';
import type { AssetInfo } from './detect.js';
import { extractGodotAsset } from './godot.js';
import { extractUnityAsset } from './unity.js';
import { extractUnrealAsset } from './unreal.js';

/** Index-time ref extraction for one asset file. Unknown engines yield nothing. */
export function extractAssetRefs(info: AssetInfo, relPath: string, source: string): AssetRefInsert[] {
  switch (info.engine) {
    case 'godot':
      return extractGodotAsset(info.kind, source);
    case 'unity':
      return extractUnityAsset(info.kind, relPath, source);
    case 'unreal':
      return extractUnrealAsset(info.kind, source);
  }
}
