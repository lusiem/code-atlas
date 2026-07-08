import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ignoreFactory, { type Ignore } from 'ignore';
import type { AtlasConfig } from '../config.js';
import { assetForPath, type AssetInfo } from '../engines/detect.js';
import { languageForPath } from '../languages.js';
import type { LanguageId } from '../types.js';

export interface ScannedFile {
  /** Path relative to root, forward slashes. */
  relPath: string;
  absPath: string;
  lang: LanguageId;
  size: number;
  mtimeMs: number;
}

export interface ScannedAsset {
  relPath: string;
  absPath: string;
  info: AssetInfo;
  size: number;
  mtimeMs: number;
}

export interface ScanResult {
  files: ScannedFile[];
  assets: ScannedAsset[];
}

/** Directories that are never worth indexing, regardless of gitignore. */
export const DEFAULT_IGNORES = [
  '.git/',
  '.hg/',
  '.svn/',
  'node_modules/',
  '.code-atlas/',
  // build outputs
  'dist/',
  'build/',
  'out/',
  'target/',
  'obj/',
  '.next/',
  '.nuxt/',
  'coverage/',
  '__pycache__/',
  '.venv/',
  'venv/',
  '.tox/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.pytest_cache/',
  // IDE state
  '.idea/',
  '.vs/',
  '.vscode/',
  // Unity
  'Library/',
  'Temp/',
  'Logs/',
  'UserSettings/',
  // Unreal
  'Intermediate/',
  'Saved/',
  'DerivedDataCache/',
  'Binaries/',
  // Godot
  '.godot/',
  '.import/',
];

interface MatcherFrame {
  /** Directory (relative to root, '' for root) this matcher's patterns are relative to. */
  base: string;
  ig: Ignore;
}

/**
 * Walks the workspace applying .gitignore semantics (including nested .gitignore
 * files) plus built-in and configured excludes. Returns indexable source files.
 */
export function scanWorkspace(config: AtlasConfig): ScanResult {
  const rootIg = ignoreFactory().add(DEFAULT_IGNORES).add(config.exclude);
  const results: ScannedFile[] = [];
  const assets: ScannedAsset[] = [];
  walk(config.root, '', [{ base: '', ig: rootIg }]);
  results.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  assets.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  return { files: results, assets };

  function isIgnored(frames: MatcherFrame[], relPath: string, isDir: boolean): boolean {
    const probe = isDir ? `${relPath}/` : relPath;
    for (const frame of frames) {
      const scoped =
        frame.base === '' ? probe : probe.startsWith(`${frame.base}/`) ? probe.slice(frame.base.length + 1) : null;
      if (scoped !== null && scoped !== '' && frame.ig.ignores(scoped)) return true;
    }
    return false;
  }

  function walk(absDir: string, relDir: string, frames: MatcherFrame[]): void {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable dir: skip
    }

    let localFrames = frames;
    if (entries.some((e) => e.isFile() && e.name === '.gitignore')) {
      try {
        const patterns = readFileSync(join(absDir, '.gitignore'), 'utf8');
        localFrames = [...frames, { base: relDir, ig: ignoreFactory().add(patterns) }];
      } catch {
        // unreadable .gitignore: proceed without it
      }
    }

    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (isIgnored(localFrames, rel, true)) continue;
        walk(join(absDir, entry.name), rel, localFrames);
      } else if (entry.isFile()) {
        const lang = languageForPath(entry.name);
        const asset = assetForPath(entry.name);
        if ((!lang || !lang.grammarAvailable) && !asset) continue;
        if (isIgnored(localFrames, rel, false)) continue;
        const abs = join(absDir, entry.name);
        let stat;
        try {
          stat = statSync(abs);
        } catch {
          continue;
        }
        if (stat.size > config.maxFileBytes) continue;
        if (lang?.grammarAvailable) {
          results.push({
            relPath: rel,
            absPath: abs,
            lang: lang.id,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          });
        }
        if (asset) {
          assets.push({ relPath: rel, absPath: abs, info: asset, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      }
    }
  }
}
