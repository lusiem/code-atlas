import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportRow, Store, SymbolLite } from '../db/store.js';
import type { EdgeInsert } from '../db/store.js';
import type { EdgeKind, LanguageId } from '../types.js';

/**
 * Structural (index-only) resolution pass. Heuristic by design: everything it
 * writes carries a confidence score and provenance 'index'; the LSP layer
 * (Phase 4) overlays precise results where available.
 *
 * Confidence scale used throughout:
 *   0.90 explicitly imported name, found in the resolved target file
 *   0.85 unique match in the same file
 *   0.70 several same-file candidates / unique match in an imported file
 *   0.60 unique match across the whole workspace
 *   0.35 ambiguous: best of a small global candidate set
 */

const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'trait', 'enum', 'type_alias', 'impl']);

interface WorkspaceIndex {
  pathToFileId: Map<string, number>;
  fileIdToPath: Map<number, string>;
  fileIdToLang: Map<number, LanguageId>;
  /** name -> local symbols, per file. */
  fileSymbolsByName: Map<number, Map<string, SymbolLite[]>>;
  /** symbols per file ordered by position (for enclosing-symbol lookup). */
  fileSymbols: Map<number, SymbolLite[]>;
  globalByName: Map<string, SymbolLite[]>;
  /** local bound name -> imported-from file id, per file. */
  importedNames: Map<number, Map<string, number>>;
  /** all files a file imports (resolved only), per file. */
  importedFiles: Map<number, Set<number>>;
}

export interface ResolveStats {
  imports: { total: number; resolved: number };
  occurrences: { total: number; resolved: number };
  edges: number;
}

export function resolveWorkspace(store: Store, rootDir: string): ResolveStats {
  const files = store.listFiles();
  const pathToFileId = new Map(files.map((f) => [f.path, f.id]));
  const fileIdToPath = new Map(files.map((f) => [f.id, f.path]));
  const fileIdToLang = new Map(files.map((f) => [f.id, f.lang]));

  // 1. imports -> files
  const importRows = store.listImportRows();
  const goModule = readGoModule(rootDir);
  const resolutions: Array<{ id: number; fileId: number | null }> = [];
  for (const imp of importRows) {
    const target = resolveImport(imp, pathToFileId, goModule);
    resolutions.push({ id: imp.id, fileId: target });
    imp.resolvedFileId = target;
  }
  store.applyImportResolutions(resolutions);

  // 2. build in-memory symbol tables
  const symbols = store.listSymbolsLite();
  const ws: WorkspaceIndex = {
    pathToFileId,
    fileIdToPath,
    fileIdToLang,
    fileSymbolsByName: new Map(),
    fileSymbols: new Map(),
    globalByName: new Map(),
    importedNames: new Map(),
    importedFiles: new Map(),
  };
  for (const sym of symbols) {
    let perFile = ws.fileSymbolsByName.get(sym.fileId);
    if (!perFile) ws.fileSymbolsByName.set(sym.fileId, (perFile = new Map()));
    push(perFile, sym.name, sym);
    push(ws.globalByName, sym.name, sym);
    let list = ws.fileSymbols.get(sym.fileId);
    if (!list) ws.fileSymbols.set(sym.fileId, (list = []));
    list.push(sym);
  }
  for (const list of ws.fileSymbols.values()) {
    list.sort((a, b) => a.startLine - b.startLine || a.startCol - b.startCol);
  }
  for (const imp of importRows) {
    if (imp.resolvedFileId === null) continue;
    let names = ws.importedNames.get(imp.fileId);
    if (!names) ws.importedNames.set(imp.fileId, (names = new Map()));
    for (const name of imp.names) {
      if (name !== '*') names.set(name, imp.resolvedFileId);
    }
    let targets = ws.importedFiles.get(imp.fileId);
    if (!targets) ws.importedFiles.set(imp.fileId, (targets = new Set()));
    targets.add(imp.resolvedFileId);
  }

  // 3. occurrences -> symbols
  const occurrences = store.listOccurrenceRows();
  const occResolutions: Array<{ id: number; symbolId: number; confidence: number }> = [];
  const edges: EdgeInsert[] = [];
  for (const occ of occurrences) {
    const hit = resolveName(ws, occ.fileId, occ.name, occ.role === 'call');
    if (!hit) continue;
    occResolutions.push({ id: occ.id, symbolId: hit.symbol.id, confidence: hit.confidence });
    if (occ.role === 'call') {
      const src = enclosingSymbol(ws, occ.fileId, occ.startLine, occ.startCol);
      if (src && src.id !== hit.symbol.id) {
        edges.push({
          srcSymbolId: src.id,
          dstSymbolId: hit.symbol.id,
          kind: 'calls',
          confidence: hit.confidence,
          provenance: 'index',
        });
      }
    }
  }
  store.applyOccurrenceResolutions(occResolutions);

  // 4. declared bases -> extends/implements edges
  for (const sym of symbols) {
    for (const base of sym.bases) {
      const hit = resolveBase(ws, sym, base.name);
      if (!hit) continue;
      edges.push({
        srcSymbolId: sym.id,
        dstSymbolId: hit.symbol.id,
        kind: base.kind as EdgeKind,
        confidence: hit.confidence,
        provenance: 'index',
      });
    }
  }

  store.clearEdges('index');
  store.insertEdges(edges);
  store.setMeta('resolved_at', String(Date.now()));

  return {
    imports: {
      total: importRows.length,
      resolved: importRows.filter((i) => i.resolvedFileId !== null).length,
    },
    occurrences: { total: occurrences.length, resolved: occResolutions.length },
    edges: edges.length,
  };
}

function push<K>(map: Map<K, SymbolLite[]>, key: K, sym: SymbolLite): void {
  const list = map.get(key);
  if (list) list.push(sym);
  else map.set(key, [sym]);
}

interface Hit {
  symbol: SymbolLite;
  confidence: number;
}

/**
 * Candidate-ranked name resolution: explicit import > same file > imported
 * files > unique global > small ambiguous set.
 */
function resolveName(ws: WorkspaceIndex, fileId: number, name: string, isCall: boolean): Hit | null {
  // callable-ish kinds are preferred for call sites
  const prefer = (list: SymbolLite[]): SymbolLite[] => {
    if (!isCall) return list;
    const callable = list.filter(
      (s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'constructor' || s.kind === 'macro' || s.kind === 'class' || s.kind === 'struct',
    );
    return callable.length > 0 ? callable : list;
  };

  const importedFrom = ws.importedNames.get(fileId)?.get(name);
  if (importedFrom !== undefined) {
    const candidates = prefer(
      (ws.fileSymbolsByName.get(importedFrom)?.get(name) ?? []).filter((s) => s.isExported),
    );
    if (candidates.length > 0) return { symbol: candidates[0]!, confidence: 0.9 };
  }

  const local = prefer(ws.fileSymbolsByName.get(fileId)?.get(name) ?? []);
  if (local.length === 1) return { symbol: local[0]!, confidence: 0.85 };
  if (local.length > 1) return { symbol: local[0]!, confidence: 0.7 };

  const importedFiles = ws.importedFiles.get(fileId);
  if (importedFiles) {
    const fromImports: SymbolLite[] = [];
    for (const target of importedFiles) {
      for (const s of ws.fileSymbolsByName.get(target)?.get(name) ?? []) {
        if (s.isExported) fromImports.push(s);
      }
    }
    const candidates = prefer(fromImports);
    if (candidates.length === 1) return { symbol: candidates[0]!, confidence: 0.7 };
    if (candidates.length > 1) return { symbol: lowestId(candidates), confidence: 0.5 };
  }

  const global = prefer((ws.globalByName.get(name) ?? []).filter((s) => s.isExported));
  if (global.length === 1) return { symbol: global[0]!, confidence: 0.6 };
  if (global.length > 1 && global.length <= 4) return { symbol: lowestId(global), confidence: 0.35 };
  return null;
}

/** Resolve a declared base-type name to a type symbol. */
function resolveBase(ws: WorkspaceIndex, sym: SymbolLite, rawName: string): Hit | null {
  // `ns::Base`, `pkg.Base`, `Base<T>` -> try the raw text, then the last segment
  const names = [rawName];
  const short = rawName.split(/::|\./).pop();
  if (short && short !== rawName) names.push(short);

  for (const name of names) {
    const typed = (list: SymbolLite[]): SymbolLite[] => list.filter((s) => TYPE_KINDS.has(s.kind) && s.id !== sym.id);

    const local = typed(ws.fileSymbolsByName.get(sym.fileId)?.get(name) ?? []);
    if (local.length > 0) return { symbol: local[0]!, confidence: 0.9 };

    const importedFrom = ws.importedNames.get(sym.fileId)?.get(name);
    if (importedFrom !== undefined) {
      const hits = typed(ws.fileSymbolsByName.get(importedFrom)?.get(name) ?? []);
      if (hits.length > 0) return { symbol: hits[0]!, confidence: 0.9 };
    }

    const fromImports: SymbolLite[] = [];
    for (const target of ws.importedFiles.get(sym.fileId) ?? []) {
      fromImports.push(...typed(ws.fileSymbolsByName.get(target)?.get(name) ?? []));
    }
    if (fromImports.length > 0) return { symbol: lowestId(fromImports), confidence: 0.85 };

    const global = typed((ws.globalByName.get(name) ?? []).filter((s) => s.isExported));
    if (global.length === 1) return { symbol: global[0]!, confidence: 0.7 };
    if (global.length > 1 && global.length <= 4) return { symbol: lowestId(global), confidence: 0.4 };
  }
  return null;
}

function lowestId(list: SymbolLite[]): SymbolLite {
  return list.reduce((a, b) => (a.id <= b.id ? a : b));
}

/** Innermost symbol containing a position (smallest line span wins). */
function enclosingSymbol(
  ws: WorkspaceIndex,
  fileId: number,
  line: number,
  col: number,
): SymbolLite | null {
  let best: SymbolLite | null = null;
  let bestSpan = Infinity;
  for (const sym of ws.fileSymbols.get(fileId) ?? []) {
    if (sym.startLine > line) break; // sorted by start
    const startsBefore =
      sym.startLine < line || (sym.startLine === line && sym.startCol <= col);
    const endsAfter = sym.endLine > line || (sym.endLine === line && sym.endCol >= col);
    if (!startsBefore || !endsAfter) continue;
    const span = sym.endLine - sym.startLine;
    if (span <= bestSpan) {
      best = sym;
      bestSpan = span;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// import specifier -> file
// ---------------------------------------------------------------------------

function readGoModule(rootDir: string): string | null {
  try {
    const text = readFileSync(join(rootDir, 'go.mod'), 'utf8');
    return /^module\s+(\S+)/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

function resolveImport(
  imp: ImportRow,
  pathToFileId: Map<string, number>,
  goModule: string | null,
): number | null {
  const path = resolveImportPath(imp, pathToFileId, goModule);
  return path === null ? null : (pathToFileId.get(path) ?? null);
}

function resolveImportPath(
  imp: ImportRow,
  pathToFileId: Map<string, number>,
  goModule: string | null,
): string | null {
  const has = (p: string): boolean => pathToFileId.has(p);
  const dir = parentDir(imp.path);

  switch (imp.lang) {
    case 'typescript':
    case 'tsx':
    case 'javascript': {
      const spec = imp.specifier;
      if (!spec.startsWith('.')) return null; // bare specifier: external package
      const base = normalize(joinPosix(dir, spec));
      const candidates: string[] = [];
      // NodeNext style: './x.js' written for a './x.ts' source
      const tsSwap = base.replace(/\.(js|mjs|cjs|jsx)$/, (m) =>
        m === '.mjs' ? '.mts' : m === '.cjs' ? '.cts' : '.ts',
      );
      if (tsSwap !== base) candidates.push(tsSwap, tsSwap.replace(/\.ts$/, '.tsx'));
      candidates.push(base);
      for (const ext of ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs']) {
        candidates.push(base + ext);
      }
      for (const idx of ['/index.ts', '/index.tsx', '/index.js', '/index.jsx']) {
        candidates.push(base + idx);
      }
      return candidates.find(has) ?? null;
    }

    case 'python': {
      const spec = imp.specifier;
      const dots = /^\.*/.exec(spec)![0].length;
      const rest = spec.slice(dots).split('.').filter(Boolean).join('/');
      const bases: string[] = [];
      if (dots > 0) {
        // relative import: one dot = current package, each extra dot = one up
        let rel = dir;
        for (let i = 1; i < dots; i++) rel = parentDir(rel);
        bases.push(rel);
      } else {
        bases.push('', dir); // project root, then importer-relative
      }
      for (const b of bases) {
        const stem = rest.length > 0 ? joinPosix(b, rest) : b;
        for (const cand of [`${stem}.py`, `${stem}/__init__.py`, `${stem}.pyi`]) {
          const n = normalize(cand);
          if (has(n)) return n;
        }
      }
      return null;
    }

    case 'go': {
      const spec = imp.specifier;
      let subdir: string | null = null;
      if (goModule && spec === goModule) subdir = '';
      else if (goModule && spec.startsWith(`${goModule}/`)) subdir = spec.slice(goModule.length + 1);
      else if (!spec.includes('.')) return null; // stdlib
      if (subdir === null) return null;
      // a package is a directory: resolve to its first .go file
      const prefix = subdir === '' ? '' : `${subdir}/`;
      const inDir = [...pathToFileId.keys()]
        .filter((p) => p.startsWith(prefix) && p.endsWith('.go') && !p.slice(prefix.length).includes('/'))
        .sort();
      return inDir[0] ?? null;
    }

    case 'rust': {
      const spec = imp.specifier;
      if (spec.startsWith('./')) {
        // `mod name;` -> sibling file or directory module
        const name = spec.slice(2);
        for (const cand of [
          joinPosix(dir, `${name}.rs`),
          joinPosix(dir, `${name}/mod.rs`),
          // mod decls in main.rs/lib.rs at src root
          `src/${name}.rs`,
          `src/${name}/mod.rs`,
        ]) {
          const n = normalize(cand);
          if (has(n)) return n;
        }
        return null;
      }
      const segs = spec.split('::');
      const head = segs.shift();
      let baseDirs: string[];
      if (head === 'crate') baseDirs = ['src', ''];
      else if (head === 'self') baseDirs = [dir];
      else if (head === 'super') baseDirs = [parentDir(dir)];
      else return null; // external crate
      for (const baseDir of baseDirs) {
        for (let k = segs.length; k >= 1; k--) {
          const stem = joinPosix(baseDir, segs.slice(0, k).join('/'));
          for (const cand of [`${stem}.rs`, `${stem}/mod.rs`]) {
            const n = normalize(cand);
            if (has(n)) return n;
          }
        }
      }
      return null;
    }

    case 'java':
    case 'kotlin': {
      const spec = imp.specifier.replace(/\.\*$/, '');
      const stem = spec.replace(/\./g, '/');
      for (const ext of ['.java', '.kt']) {
        const suffix = stem + ext;
        const matches = [...pathToFileId.keys()].filter((p) => p === suffix || p.endsWith(`/${suffix}`));
        if (matches.length === 1) return matches[0]!;
      }
      return null;
    }

    case 'c':
    case 'cpp': {
      const spec = imp.specifier;
      if (spec.startsWith('<')) return null; // system include
      for (const cand of [joinPosix(dir, spec), spec]) {
        const n = normalize(cand);
        if (has(n)) return n;
      }
      // unique basename match (include paths unknown without compile_commands)
      const base = spec.split('/').pop()!;
      const matches = [...pathToFileId.keys()].filter((p) => p.endsWith(`/${base}`) || p === base);
      return matches.length === 1 ? matches[0]! : null;
    }

    case 'c_sharp':
      return null; // namespaces do not map to files

    default:
      return null;
  }
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function joinPosix(a: string, b: string): string {
  if (a === '') return b;
  return `${a}/${b}`;
}

/** Resolve '.' and '..' segments in a root-relative forward-slash path. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}
