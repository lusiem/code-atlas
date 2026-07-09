import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { relative, sep } from 'node:path';
import type { AppContext } from '../context.js';
import { extractorFor, supportedLanguages } from '../parsing/registry.js';
import { compileQuery, parse } from '../parsing/loader.js';
import { semanticSearch } from '../embeddings/search.js';
import { lspHoverFor } from '../lsp/overlay.js';
import { formatSymbolLine, kindPrefix, paginationFooter, readSnippet } from './format.js';
import { registerDiagramTool } from './diagram.js';
import { registerEngineTools } from './engines.js';
import { registerGraphTools } from './graph.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageId, SymbolKind, SymbolRow } from '../types.js';

const KIND_VALUES = [
  'function', 'method', 'constructor', 'class', 'interface', 'trait', 'struct', 'enum',
  'enum_member', 'type_alias', 'variable', 'constant', 'property', 'field', 'namespace',
  'module', 'signal', 'macro', 'impl',
] as const;

const LANG_VALUES = [
  'typescript', 'tsx', 'javascript', 'python', 'c', 'cpp', 'rust', 'go', 'java', 'kotlin',
  'c_sharp', 'gdscript',
] as const;

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

/** Accept absolute or relative, forward or back slashes; return root-relative forward-slash path. */
function normalizeRel(ctx: AppContext, p: string): string {
  const withSlashes = p.replace(/\\/g, '/');
  const rel = /^[a-zA-Z]:\//.test(withSlashes) || withSlashes.startsWith('/')
    ? relative(ctx.config.root, p).split(sep).join('/')
    : withSlashes;
  return rel.replace(/^\.\//, '');
}

export function registerTools(server: McpServer, ctx: AppContext): void {
  registerGraphTools(server, ctx);
  registerEngineTools(server, ctx);
  registerDiagramTool(server, ctx);

  server.registerTool(
    'project_overview',
    {
      title: 'Project overview',
      description:
        'High-level map of the indexed workspace: languages, file/symbol counts, and index freshness. ' +
        'Call this first in a session to orient yourself.',
      inputSchema: {},
    },
    async () => {
      const { store, indexer, config } = ctx;
      const counts = store.countsByLanguage();
      const stats = store.stats();
      const lines: string[] = [];
      lines.push(`workspace: ${config.root}`);
      lines.push(`index: ${indexer.progress.state}${indexer.progress.state === 'indexing' ? ` (${indexer.progress.processedFiles}/${indexer.progress.totalFiles})` : ''}`);
      lines.push(
        `totals: ${stats.files} files, ${stats.symbols} symbols, ${stats.imports} imports, ${stats.occurrences} occurrences, ${stats.edges} graph edges`,
      );
      if (counts.length > 0) {
        lines.push('', 'languages:');
        for (const c of counts) lines.push(`  ${c.lang}: ${c.files} files, ${c.symbols} symbols`);
      }
      const assetStats = store.assetStats();
      if (assetStats.length > 0) {
        const byEngine = new Map<string, string[]>();
        for (const a of assetStats) {
          const list = byEngine.get(a.engine) ?? [];
          list.push(`${a.n} ${a.kind}`);
          byEngine.set(a.engine, list);
        }
        lines.push('', 'engine assets:');
        for (const [engine, parts] of byEngine) lines.push(`  ${engine}: ${parts.join(', ')}`);
      }
      lines.push('', `extractors active: ${supportedLanguages().join(', ')}`);
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'index_status',
    {
      title: 'Index status',
      description: 'Indexing progress, per-file errors, and freshness of the code index.',
      inputSchema: {},
    },
    async () => {
      const p = ctx.indexer.progress;
      const lines = [
        `state: ${p.state}`,
        `files: ${p.processedFiles}/${p.totalFiles} processed, ${p.changedFiles} (re)indexed, ${p.removedFiles} removed`,
      ];
      if (p.startedAt) {
        const took = (p.finishedAt ?? Date.now()) - p.startedAt;
        lines.push(`last sweep: started ${new Date(p.startedAt).toISOString()}, ${p.finishedAt ? `took ${took} ms` : `running for ${took} ms`}`);
      }
      if (p.resolve) {
        lines.push(
          `last resolution (${p.resolve.mode}, ${p.resolve.files} files): ` +
            `${p.resolve.imports.resolved}/${p.resolve.imports.total} imports, ` +
            `${p.resolve.occurrences.resolved}/${p.resolve.occurrences.total} occurrences considered, ` +
            `${p.resolve.edges} edges written`,
        );
      }
      const w = ctx.watcher?.status;
      lines.push(
        w?.watching
          ? `watcher: active, ${w.batches} batches applied` +
              (w.lastBatchAt ? `, last at ${new Date(w.lastBatchAt).toISOString()}` : '') +
              (w.pending > 0 ? `, ${w.pending} paths pending` : '')
          : 'watcher: off (refresh via reindex or restart)',
      );
      if (ctx.lsp) lines.push(...ctx.lsp.statusLines());
      if (ctx.embedder) lines.push(...ctx.embedder.statusLines());
      if (p.errors.length > 0) {
        lines.push('', `errors (${p.errors.length}):`);
        for (const e of p.errors.slice(0, 10)) lines.push(`  ${e.path}: ${e.message}`);
      }
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'reindex',
    {
      title: 'Reindex workspace',
      description: 'Force an incremental re-scan of the workspace (hash-checks every file, reindexes changed ones).',
      inputSchema: {},
    },
    async () => {
      void ctx.indexer.run();
      return text('reindex started; poll index_status for progress');
    },
  );

  server.registerTool(
    'search_symbols',
    {
      title: 'Search symbols',
      description:
        'Search definitions (functions, classes, methods, …) by name across the whole workspace. ' +
        'Matches name prefixes and doc comments; falls back to substring match. ' +
        'Returns one line per symbol with its id (#N) for use with get_symbol_info.',
      inputSchema: {
        query: z.string().min(1).describe('symbol name or name fragment, e.g. "parseConfig" or "http client"'),
        kind: z.enum(KIND_VALUES).optional().describe('filter by symbol kind'),
        lang: z.enum(LANG_VALUES).optional(),
        path_prefix: z.string().optional().describe('restrict to files under this root-relative path'),
        exported_only: z.boolean().optional().describe('only public/exported symbols'),
        limit: z.number().int().min(1).max(200).default(20),
        offset: z.number().int().min(0).default(0),
      },
    },
    async (args) => {
      const rows = ctx.store.searchSymbols(args.query, {
        kind: args.kind as SymbolKind | undefined,
        lang: args.lang as LanguageId | undefined,
        pathPrefix: args.path_prefix ? normalizeRel(ctx, args.path_prefix) : undefined,
        exportedOnly: args.exported_only,
        limit: args.limit,
        offset: args.offset,
      });
      if (rows.length === 0) return text(`no symbols matching "${args.query}"`);
      const body = rows.map((r) => formatSymbolLine(r)).join('\n');
      return text(body + paginationFooter(rows.length, args.limit, args.offset));
    },
  );

  server.registerTool(
    'semantic_search',
    {
      title: 'Semantic code search',
      description:
        'Natural-language search over the code: describe behavior ("where is retry backoff implemented", ' +
        '"function that validates auth tokens") rather than symbol names. Hybrid keyword+embedding ranking, ' +
        'fully local. First-ever call downloads the embedding model (~150 MB one-time); until embedding ' +
        'coverage completes, results are keyword-weighted and say so.',
      inputSchema: {
        query: z.string().min(1).describe('what the code does, in plain language'),
        k: z.number().int().min(1).max(50).default(10),
        lang: z.enum(LANG_VALUES).optional(),
      },
    },
    async (args) => {
      const result = await semanticSearch(ctx, args.query, args.k, args.lang as LanguageId | undefined);
      if (result.hits.length === 0) {
        return text(`no matches for "${args.query}"${result.note ? `\n(${result.note})` : ''}`);
      }
      const lines = result.hits.map((h) => {
        const cos = h.cosine !== null ? ` cos=${h.cosine.toFixed(2)}` : '';
        return `[${h.sources}${cos}] ${formatSymbolLine(h.symbol)}`;
      });
      if (result.note) lines.push(`(${result.note})`);
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'get_file_outline',
    {
      title: 'File outline',
      description:
        'Hierarchical outline of every definition in a file, with signatures — read the structure of a file ' +
        'without reading its source. Set include_docs to also get first-line doc comments.',
      inputSchema: {
        path: z.string().describe('file path, relative to the workspace root'),
        include_docs: z.boolean().default(false),
      },
    },
    async (args) => {
      const rel = normalizeRel(ctx, args.path);
      const file = ctx.store.getFileByPath(rel);
      if (!file) return text(`file not indexed: ${rel} (is the path relative to ${ctx.config.root}?)`);
      const symbols = ctx.store.symbolsForFile(file.id);
      if (symbols.length === 0) return text(`${rel}: no symbols extracted`);

      const byId = new Map(symbols.map((s) => [s.id, s]));
      const depthOf = (s: SymbolRow): number => {
        let d = 0;
        let cur = s;
        let guard = 0;
        while (cur.parentSymbolId !== null && guard++ < 32) {
          const parent = byId.get(cur.parentSymbolId);
          if (!parent) break;
          d++;
          cur = parent;
        }
        return d;
      };
      const lines = symbols.map((s) => {
        const indent = '  '.repeat(depthOf(s));
        const sig = s.signature ?? s.name;
        const doc = args.include_docs && s.docComment ? `\n${indent}    ${s.docComment.split('\n')[0]}` : '';
        return `${indent}${s.startLine}: ${kindPrefix(s)}${sig}${s.isExported ? '' : ' [private]'} #${s.id}${doc}`;
      });
      return text(`${rel} (${file.lang}, ${symbols.length} symbols)\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'get_symbol_info',
    {
      title: 'Symbol info',
      description:
        'Full detail for one symbol: signature, doc comment, location, container — and optionally its source. ' +
        'Identify the symbol by id (from search_symbols/get_file_outline), by file+line position, or by exact name.',
      inputSchema: {
        symbol_id: z.number().int().optional(),
        path: z.string().optional().describe('with line: look up the innermost symbol at that position'),
        line: z.number().int().min(1).optional(),
        name: z.string().optional().describe('exact name; lists all matches if ambiguous'),
        include_source: z.boolean().default(false).describe('append the symbol source (up to 60 lines)'),
      },
    },
    async (args) => {
      const { store, config } = ctx;
      let targets: SymbolRow[] = [];
      if (args.symbol_id !== undefined) {
        const row = store.getSymbolById(args.symbol_id);
        if (row) targets = [row];
      } else if (args.path && args.line !== undefined) {
        const rel = normalizeRel(ctx, args.path);
        const file = store.getFileByPath(rel);
        if (!file) return text(`file not indexed: ${rel}`);
        // no column given: match the innermost symbol anywhere on that line
        const row = store.symbolAt(file.id, args.line, Number.MAX_SAFE_INTEGER);
        if (row) targets = [row];
      } else if (args.name) {
        targets = store.symbolsByExactName(args.name);
      } else {
        return text('provide symbol_id, path+line, or name');
      }

      if (targets.length === 0) return text('symbol not found');
      if (targets.length > 1) {
        return text(
          `ambiguous — ${targets.length} matches:\n` +
            targets.map((r) => formatSymbolLine(r)).join('\n'),
        );
      }

      const sym = targets[0]!;
      const lines: string[] = [
        `${sym.kind} ${sym.qualifiedName}  (${sym.path}:${sym.startLine}-${sym.endLine}) #${sym.id}`,
        `lang: ${sym.lang}   exported: ${sym.isExported}`,
      ];
      if (sym.signature) lines.push(`signature: ${sym.signature}`);
      if (sym.parentSymbolId !== null) {
        const parent = store.getSymbolById(sym.parentSymbolId);
        if (parent) lines.push(`container: ${parent.kind} ${parent.qualifiedName} #${parent.id}`);
      }
      if (sym.docComment) lines.push('', sym.docComment);
      const hover = await lspHoverFor(ctx, sym);
      if (hover) lines.push('', `--- hover (lsp) ---`, hover);
      if (args.include_source) {
        lines.push('', readSnippet(config.root, sym.path, sym.startLine, sym.endLine, 60));
      }
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'ast_query',
    {
      title: 'AST pattern query',
      description:
        'Run a raw tree-sitter S-expression query over indexed files of one language and return every capture ' +
        'as path:line with the captured text. Powerful for structural searches no regex can express, e.g. ' +
        '`(call_expression function: (identifier) @fn (#eq? @fn "eval"))` or `(for_statement (await_expression) @hit)`. ' +
        'Parses files on demand, normalized the same way the indexer parses them (e.g. C++ dllexport macros ' +
        'blanked so class nodes parse) — use path_prefix to narrow scope on big repos.',
      inputSchema: {
        pattern: z.string().describe('tree-sitter query source'),
        lang: z.enum(LANG_VALUES),
        path_prefix: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    async (args) => {
      const lang = args.lang as LanguageId;
      try {
        await compileQuery(lang, args.pattern);
      } catch (err) {
        return text(`invalid query: ${err instanceof Error ? err.message : String(err)}`);
      }
      const prefix = args.path_prefix ? normalizeRel(ctx, args.path_prefix) : null;
      const files = ctx.store
        .listFiles()
        .filter((f) => f.lang === lang && (!prefix || f.path.startsWith(prefix)));

      const preprocess = extractorFor(lang)?.preprocess;
      const results: string[] = [];
      let scanned = 0;
      for (const file of files) {
        if (results.length >= args.limit) break;
        scanned++;
        let source: string;
        try {
          source = readFileSync(join(ctx.config.root, file.path), 'utf8');
        } catch {
          continue;
        }
        // same offset-preserving cleanup the indexer applies, so structural
        // queries see the same tree the index was built from
        if (preprocess) source = preprocess(source);
        const tree = await parse(lang, source);
        try {
          const query = await compileQuery(lang, args.pattern);
          for (const cap of query.captures(tree.rootNode)) {
            if (results.length >= args.limit) break;
            const snippet = cap.node.text.replace(/\s+/g, ' ').slice(0, 120);
            results.push(`${file.path}:${cap.node.startPosition.row + 1} @${cap.name}  ${snippet}`);
          }
        } finally {
          tree.delete();
        }
      }
      if (results.length === 0) return text(`no matches in ${scanned} ${lang} files`);
      const footer =
        results.length >= args.limit ? `\n(hit limit=${args.limit} after ${scanned}/${files.length} files — narrow with path_prefix)` : '';
      return text(results.join('\n') + footer);
    },
  );
}
