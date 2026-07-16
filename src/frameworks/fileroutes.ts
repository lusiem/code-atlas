import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtractedRoute, ExtractedSymbol, FileExtraction } from '../types.js';

/**
 * File-convention routing (Next.js, SvelteKit, Nuxt, Remix): the route is the
 * path, so extraction is scanner-shaped, not parser-shaped. Gated on a real
 * framework config marker in an ancestor directory so lookalike `app/` or
 * `pages/` trees in unrelated projects never produce routes.
 */

export type FileRouteFramework = 'nextjs' | 'sveltekit' | 'nuxt' | 'remix';

const VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const MARKER_BASENAME =
  /^(next\.config\.(js|mjs|cjs|ts)|svelte\.config\.(js|ts)|nuxt\.config\.(js|ts|mjs)|remix\.config\.(js|cjs|mjs)|react-router\.config\.(js|ts)|package\.json)$/;

/** A change to this path can flip file-route detection — invalidate the cache. */
export function isMarkerPath(relPath: string): boolean {
  return MARKER_BASENAME.test(relPath.slice(relPath.lastIndexOf('/') + 1));
}

export interface AppRoot {
  framework: FileRouteFramework;
  /** Root-relative directory holding the config marker ('' = workspace root). */
  baseDir: string;
}

/**
 * Finds the nearest ancestor directory carrying a framework config marker.
 * Memoized per directory; the indexer invalidates on sweeps and marker changes.
 */
export class FileRouteDetector {
  private readonly cache = new Map<string, AppRoot | null>();

  constructor(private readonly root: string) {}

  invalidate(): void {
    this.cache.clear();
  }

  frameworkFor(relPath: string): AppRoot | null {
    const i = relPath.lastIndexOf('/');
    return this.forDir(i === -1 ? '' : relPath.slice(0, i));
  }

  private forDir(dir: string): AppRoot | null {
    const hit = this.cache.get(dir);
    if (hit !== undefined) return hit;
    let result = this.markerAt(dir);
    if (!result && dir !== '') {
      const i = dir.lastIndexOf('/');
      result = this.forDir(i === -1 ? '' : dir.slice(0, i));
    }
    this.cache.set(dir, result);
    return result;
  }

  private markerAt(dir: string): AppRoot | null {
    const abs = join(this.root, dir);
    const has = (...names: string[]): boolean => names.some((n) => existsSync(join(abs, n)));
    if (has('next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts')) {
      return { framework: 'nextjs', baseDir: dir };
    }
    if (has('svelte.config.js', 'svelte.config.ts')) return { framework: 'sveltekit', baseDir: dir };
    if (has('nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs')) return { framework: 'nuxt', baseDir: dir };
    if (
      has('remix.config.js', 'remix.config.cjs', 'remix.config.mjs', 'react-router.config.ts', 'react-router.config.js')
    ) {
      return { framework: 'remix', baseDir: dir };
    }
    const pkg = join(abs, 'package.json');
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, 'utf8')) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const deps = { ...json.dependencies, ...json.devDependencies };
        if (Object.keys(deps).some((k) => k.startsWith('@remix-run/'))) {
          return { framework: 'remix', baseDir: dir };
        }
      } catch {
        // malformed package.json — not a marker
      }
    }
    return null;
  }
}

export interface RouteFileInfo {
  /** Route path with :param / * wildcards, matching the store's conventions. */
  path: string;
  /** server: one route per exported verb; page: GET; api: fixed/ANY method. */
  shape: 'page' | 'server' | 'api';
  /** Fixed method when the convention encodes one (Nuxt `users.get.ts`). */
  method?: string;
}

const nextSeg = (seg: string): string => {
  if (/^\[\[?\.\.\..+\]?\]$/.test(seg)) return '*';
  const m = /^\[(.+)\]$/.exec(seg);
  return m ? `:${m[1]}` : seg;
};

function nextjsInfo(appRel: string): RouteFileInfo | null {
  const rel = appRel.startsWith('src/') ? appRel.slice(4) : appRel;
  let m = /^app\/(.*)$/.exec(rel);
  if (m) {
    const parts = m[1]!.split('/');
    const file = parts.pop()!;
    const shape = /^route\.(ts|js|tsx|jsx|mjs)$/.test(file)
      ? ('server' as const)
      : /^page\.(tsx|jsx|ts|js)$/.test(file)
        ? ('page' as const)
        : null;
    if (!shape) return null;
    const segs: string[] = [];
    for (const part of parts) {
      if (part.startsWith('(') && part.endsWith(')')) continue; // route group
      if (part.startsWith('@')) continue; // parallel-route slot
      if (part.startsWith('_')) return null; // private folder
      segs.push(nextSeg(part));
    }
    return { path: `/${segs.join('/')}`, shape };
  }
  m = /^pages\/(.*)\.(tsx|jsx|ts|js|mjs)$/.exec(rel);
  if (m) {
    const parts = m[1]!.split('/');
    const base = parts.pop()!;
    if (base.startsWith('_') || parts.some((p) => p.startsWith('_'))) return null;
    if (base !== 'index') parts.push(base);
    const segs = parts.map(nextSeg);
    return { path: `/${segs.join('/')}`, shape: segs[0] === 'api' ? 'api' : 'page' };
  }
  return null;
}

const svelteSeg = (seg: string): string => {
  let m = /^\[\[(.+?)(=.+)?\]\]$/.exec(seg);
  if (m) return `:${m[1]}?`;
  if (/^\[\.\.\..+\]$/.test(seg)) return '*';
  m = /^\[(.+?)(=.+)?\]$/.exec(seg);
  return m ? `:${m[1]}` : seg;
};

function sveltekitInfo(appRel: string): RouteFileInfo | null {
  const m = /^src\/routes\/(.*)$/.exec(appRel);
  if (!m) return null;
  const parts = m[1]!.split('/');
  const file = parts.pop()!;
  const shape =
    file === '+page.svelte' ? ('page' as const) : /^\+server\.(ts|js)$/.test(file) ? ('server' as const) : null;
  if (!shape) return null;
  const segs = parts.filter((p) => !(p.startsWith('(') && p.endsWith(')'))).map(svelteSeg);
  return { path: `/${segs.join('/')}`, shape };
}

const nuxtSeg = (seg: string): string => {
  if (/^\[\.\.\..+\]$/.test(seg)) return '*';
  const m = /^\[(.+)\]$/.exec(seg);
  return m ? `:${m[1]}` : seg;
};

function nuxtInfo(appRel: string): RouteFileInfo | null {
  let m = /^pages\/(.*)\.vue$/.exec(appRel);
  if (m) {
    const parts = m[1]!.split('/');
    if (parts[parts.length - 1] === 'index') parts.pop();
    return { path: `/${parts.map(nuxtSeg).join('/')}`, shape: 'page' };
  }
  m = /^server\/(api|routes)\/(.*)\.(ts|js|mjs)$/.exec(appRel);
  if (m) {
    const parts = m[2]!.split('/');
    let base = parts.pop()!;
    let method: string | undefined;
    const suffix = /^(.*)\.(get|post|put|patch|delete|head|options)$/.exec(base);
    if (suffix) {
      base = suffix[1]!;
      method = suffix[2]!.toUpperCase();
    }
    if (base !== 'index') parts.push(base);
    const segs = parts.map(nuxtSeg);
    const prefix = m[1] === 'api' ? '/api' : '';
    return { path: `${prefix}/${segs.join('/')}`, shape: 'api', ...(method ? { method } : {}) };
  }
  return null;
}

function remixInfo(appRel: string): RouteFileInfo | null {
  const m =
    /^app\/routes\/([^/]+)\/route\.(tsx|ts|jsx|js)$/.exec(appRel) ??
    /^app\/routes\/([^/]+)\.(tsx|ts|jsx|js)$/.exec(appRel);
  if (!m) return null;
  const segs: string[] = [];
  for (const raw of m[1]!.split('.')) {
    if (raw === '_index' || raw.startsWith('_')) continue; // index / pathless layout
    let seg = raw.endsWith('_') ? raw.slice(0, -1) : raw; // trailing _ opts out of layout
    const optional = /^\((.+)\)$/.exec(seg);
    if (optional) {
      const inner = optional[1]!;
      segs.push(inner.startsWith('$') ? `:${inner.slice(1)}?` : `${inner}?`);
      continue;
    }
    if (seg === '$') seg = '*';
    else if (seg.startsWith('$')) seg = `:${seg.slice(1)}`;
    segs.push(seg);
  }
  return { path: `/${segs.join('/')}`, shape: 'page' };
}

/** Pure path→route derivation; exported for golden tests. */
export function routeFileInfo(framework: FileRouteFramework, appRel: string): RouteFileInfo | null {
  switch (framework) {
    case 'nextjs':
      return nextjsInfo(appRel);
    case 'sveltekit':
      return sveltekitInfo(appRel);
    case 'nuxt':
      return nuxtInfo(appRel);
    case 'remix':
      return remixInfo(appRel);
  }
}

function firstHandler(exported: ExtractedSymbol[]): ExtractedSymbol | undefined {
  return exported.find((s) => ['function', 'method', 'class', 'variable', 'constant'].includes(s.kind));
}

/** Routes for one file under a detected app root. Uses the existing extraction — no re-parse. */
export function extractFileRoutes(
  app: AppRoot,
  relPath: string,
  extraction: FileExtraction,
): ExtractedRoute[] {
  const appRel = app.baseDir === '' ? relPath : relPath.slice(app.baseDir.length + 1);
  const info = routeFileInfo(app.framework, appRel);
  if (!info) return [];

  const exported = extraction.symbols.filter((s) => s.isExported && s.parentIndex === null);
  const route = (method: string, handler?: ExtractedSymbol): ExtractedRoute => ({
    framework: app.framework,
    method,
    path: info.path,
    fullPath: null,
    startLine: handler?.startLine ?? 1,
    handlerLine: handler?.startLine ?? null,
    handlerName: handler?.name ?? null,
    detail: null,
  });

  if (info.shape === 'server') {
    const verbs = exported.filter((s) => VERBS.has(s.name));
    if (verbs.length > 0) return verbs.map((s) => route(s.name, s));
    return [route('ANY')];
  }
  if (app.framework === 'remix') {
    const action = exported.find((s) => s.name === 'action');
    const handler = exported.find((s) => s.name === 'loader') ?? action ?? firstHandler(exported);
    return [route(action ? 'ANY' : 'GET', handler)];
  }
  if (info.shape === 'api') {
    return [route(info.method ?? 'ANY', firstHandler(exported))];
  }
  return [route(info.method ?? 'GET', firstHandler(exported))];
}
