import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../context.js';
import type { LanguageId, SymbolRow } from '../types.js';
import { LANGUAGES } from '../languages.js';
import { fileChurn } from '../git/churn.js';
import { formatSymbolLine, normalizeRel, paginationFooter, text } from './format.js';
import { clampText, maxTokensArg } from './tokens.js';

const LANG_VALUES = LANGUAGES.map((l) => l.id) as [LanguageId, ...LanguageId[]];

/** Kinds worth reporting as dead — bindings like variables/fields are too noisy. */
const DEAD_KINDS = [
  'function', 'method', 'class', 'interface', 'struct', 'enum', 'trait', 'type_alias', 'constant',
];

/** Unused-exports section: value kinds only — exported types are cheap and not actionable. */
const EXPORT_KINDS = ['function', 'class', 'constant', 'enum', 'struct', 'trait'];

/** Engine/framework callbacks invoked by name from outside the indexed code. */
const UNITY_MESSAGES = new Set([
  'Awake', 'Start', 'Update', 'FixedUpdate', 'LateUpdate', 'OnEnable', 'OnDisable', 'OnDestroy',
  'OnGUI', 'OnValidate', 'Reset', 'OnApplicationQuit', 'OnApplicationPause',
]);
const UNREAL_LIFECYCLE = new Set([
  'BeginPlay', 'EndPlay', 'Tick', 'NativeConstruct', 'NativeDestruct', 'GetLifetimeReplicatedProps',
  'SetupPlayerInputComponent', 'PostInitializeComponents',
]);

function isLifecycle(sym: SymbolRow): boolean {
  if (sym.lang === 'gdscript') return sym.name.startsWith('_'); // Godot virtual callbacks
  if (sym.lang === 'python') return /^__.*__$/.test(sym.name);
  if (sym.lang === 'c_sharp') return UNITY_MESSAGES.has(sym.name);
  if (sym.lang === 'cpp' || sym.lang === 'c') return UNREAL_LIFECYCLE.has(sym.name);
  return sym.name === 'main';
}

/** Paths package.json names as entry points (main/bin/exports) — callers live outside the index. */
function entryPointPaths(root: string): Set<string> {
  const out = new Set<string>();
  const norm = (p: unknown): void => {
    if (typeof p === 'string') out.add(p.replace(/^\.\//, ''));
    else if (p && typeof p === 'object') for (const v of Object.values(p)) norm(v);
  };
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    norm(pkg['main']);
    norm(pkg['bin']);
    norm(pkg['exports']);
  } catch {
    // no package.json — nothing to exclude
  }
  return out;
}

const ENTRY_BASENAME = /^(main|__main__|index|app|server|cli)\.[^.]+$/;

export function registerHealthTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'find_dead_code',
    {
      title: 'Find dead code',
      description:
        'Symbols nothing references: no resolved occurrence and no graph edge points at them, after ' +
        'excluding entry points, route handlers, and engine/framework lifecycle callbacks. Candidates ' +
        'with unresolved same-name usages elsewhere are hedged as "possibly dead" — dynamic dispatch and ' +
        'reflection are invisible to a structural index, so treat this as a review list, not a delete list. ' +
        'A second section lists exported symbols only ever used inside their own file.',
      inputSchema: {
        lang: z.enum(LANG_VALUES).optional(),
        path_prefix: z.string().optional().describe('restrict to files under this root-relative path'),
        include_exports: z.boolean().default(true)
          .describe('also list exported symbols with internal-only references'),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
        ...maxTokensArg,
      },
    },
    async (args) => {
      const opts = {
        kinds: DEAD_KINDS,
        ...(args.lang ? { lang: args.lang as LanguageId } : {}),
        ...(args.path_prefix ? { pathPrefix: normalizeRel(ctx, args.path_prefix) } : {}),
        limit: 2000,
      };
      const { handlerIds, fileIds: routeFileIds } = ctx.store.routeAnchors();
      const entries = entryPointPaths(ctx.config.root);
      const files = new Map(ctx.store.listFiles().map((f) => [f.path, f]));

      const keep = (s: SymbolRow): boolean => {
        if (handlerIds.has(s.id)) return false;
        if (isLifecycle(s)) return false;
        const file = files.get(s.path);
        if (file && routeFileIds.has(file.id)) return false; // decorator-routed files
        if (entries.has(s.path)) return false;
        const base = s.path.slice(s.path.lastIndexOf('/') + 1);
        if (ENTRY_BASENAME.test(base) && s.path.split('/').length <= 2) return false;
        return true;
      };

      const candidates = ctx.store.deadCandidates(opts).filter(keep);
      const main = candidates.filter((s) => !files.get(s.path)?.isTest);
      const testOnly = candidates.filter((s) => Boolean(files.get(s.path)?.isTest));
      // methods hedge on ANY same-name usage: a call resolved to a same-named
      // method on another type is exactly the dispatch ambiguity to fear
      const methodNames = main.filter((s) => s.kind === 'method').map((s) => s.name);
      const otherNames = main.filter((s) => s.kind !== 'method').map((s) => s.name);
      const nameHits = ctx.store.nameOccurrenceCounts(otherNames, true);
      for (const [name, n] of ctx.store.nameOccurrenceCounts(methodNames, false)) {
        nameHits.set(name, Math.max(nameHits.get(name) ?? 0, n));
      }

      const lines: string[] = [];
      const shown = main.slice(args.offset, args.offset + args.limit);
      lines.push(`unreferenced symbols: ${main.length}${main.length >= 2000 ? '+' : ''} candidate(s)`);
      if (shown.length === 0) {
        lines.push('none found — or everything surviving the exclusions is referenced');
      }
      for (const s of shown) {
        const hits = nameHits.get(s.name);
        const verdict = hits
          ? `possibly dead — ${hits} same-name usage(s) elsewhere (dynamic dispatch?)`
          : 'dead (high confidence)';
        lines.push(`${formatSymbolLine(s)}\n    ${verdict}`);
      }
      lines.push(paginationFooter(shown.length, args.limit, args.offset).trim());

      if (testOnly.length > 0) {
        lines.push('', `test-only files (${testOnly.length} unreferenced helper(s)):`);
        for (const s of testOnly.slice(0, 10)) lines.push(`  ${formatSymbolLine(s)}`);
      }

      if (args.include_exports) {
        const internal = ctx.store
          .internalOnlyExports({ ...opts, kinds: EXPORT_KINDS })
          .filter(keep)
          .filter((s) => !files.get(s.path)?.isTest);
        if (internal.length > 0) {
          lines.push('', `unused exports (referenced only inside their own file): ${internal.length}`);
          for (const s of internal.slice(0, args.limit)) lines.push(`  ${formatSymbolLine(s)}`);
        }
      }

      lines.push(
        '',
        '(structural index: reflection, dependency injection, string-keyed lookups, and external consumers are invisible — verify before deleting)',
      );
      return text(clampText(lines.filter((l) => l !== '').join('\n').replace(/\n{3,}/g, '\n\n'), args.max_tokens));
    },
  );

  server.registerTool(
    'hotspots',
    {
      title: 'Churn hotspots',
      description:
        'Risk-ranked files: git commit churn over a window multiplied by current size ' +
        '(score = commits × log2(lines)). High churn on large files marks refactor and review targets.',
      inputSchema: {
        since: z.string().default('90 days').describe('git --since window, e.g. "30 days", "6 months"'),
        path_prefix: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        ...maxTokensArg,
      },
    },
    async (args) => {
      const result = await fileChurn(ctx.config.root, args.since);
      if (!result.ok) return text(`hotspots unavailable: ${result.reason}`);
      if (result.commits === 0) return text(`no commits in the last ${args.since}`);

      const sizes = ctx.store.fileLineCounts();
      const prefix = args.path_prefix ? normalizeRel(ctx, args.path_prefix) : null;
      const rows: Array<{ path: string; commits: number; added: number; deleted: number; lines: number; score: number }> = [];
      for (const [path, c] of result.churn) {
        const lines = sizes.get(path);
        if (lines === undefined) continue; // not an indexed code file
        if (prefix && !path.startsWith(prefix)) continue;
        rows.push({ path, ...c, lines, score: c.commits * Math.log2(lines + 1) });
      }
      rows.sort((a, b) => b.score - a.score);

      const lines: string[] = [
        `hotspots over the last ${args.since} (${result.commits} commits scanned):`,
      ];
      if (result.shallow) lines.push('note: shallow clone — history (and churn) is under-reported');
      if (rows.length === 0) {
        lines.push('no indexed files changed in the window');
        return text(lines.join('\n'));
      }
      const width = Math.min(60, Math.max(...rows.slice(0, args.limit).map((r) => r.path.length)));
      for (const r of rows.slice(0, args.limit)) {
        lines.push(
          `${r.path.padEnd(width)}  ${String(r.commits).padStart(3)} commits  +${r.added}/-${r.deleted}  ~${r.lines} lines  score ${r.score.toFixed(0)}`,
        );
      }
      return text(clampText(lines.join('\n'), args.max_tokens));
    },
  );
}
