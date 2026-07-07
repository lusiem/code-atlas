# code-atlas

**Multi-language code intelligence MCP server** — gives Claude Code (and any MCP client) a structured view of your codebase instead of raw text: symbol search, file outlines, AST pattern queries, cross-file references, call/type hierarchies, import graphs — and (coming) precise LSP-backed answers, semantic search, and game-engine asset understanding.

Instead of grepping and reading whole files, the model asks questions like *"outline this file"*, *"who calls `parseConfig`?"*, *"how does the request handler reach the DB layer?"* — and gets compact, token-efficient answers backed by a persistent tree-sitter index.

> **Status: early development.** Structural indexing, cross-file resolution, and the call graph work across 11 languages. See the roadmap below.

## How it works

```
your repo ──scan (gitignore-aware)──> tree-sitter parse ──> SQLite index (symbols, imports,
                                                             occurrences, call/type edges, FTS5)
                                                                   │
Claude Code ◄──────────── MCP tools over stdio ────────────────────┘
```

- **Persistent index** at `<repo>/.code-atlas/index.db` (self-gitignored), incrementally refreshed by content hash.
- **Live** — a gitignore-aware file watcher reindexes saves within a debounce beat and re-resolves only the affected files (`--no-watch` or `"watch": false` to disable).
- **Zero config** — point it at a repo root and it works. Optional `code-atlas.json` for include/exclude tweaks.
- **Everything local** — your code never leaves your machine.

## Install & use with Claude Code

```sh
git clone <this repo> && cd code-atlas
npm install && npm run build

claude mcp add code-atlas -- node /path/to/code-atlas/dist/index.js serve
```

(Once published: `claude mcp add code-atlas -- npx -y code-atlas-mcp serve`.)

The server indexes the current working directory; pass `--root <path>` to override.

### CLI

```sh
node dist/index.js index [--root <path>]              # one-shot index build (debugging / warm-up)
node dist/index.js serve [--root <path>] [--no-watch] # MCP server on stdio
```

## Tools

| Tool | What it answers |
|---|---|
| `project_overview` | What is this project? Languages, sizes, index freshness. Call first. |
| `search_symbols` | Where is *X* defined? FTS + fuzzy over names and doc comments, filterable by kind/language/path. |
| `get_file_outline` | What's in this file? Hierarchical signatures without reading source. |
| `get_symbol_info` | Everything about one symbol (by id, position, or name) incl. docs and source. |
| `ast_query` | Raw tree-sitter S-expression queries — structural search regex can't do. |
| `find_references` | Who uses this symbol? Exact (LSP) when available, else resolved usages first, name-matches as candidates. |
| `go_to_definition` | Definition of the identifier at a position. LSP-exact with index fallback. |
| `call_hierarchy` | Who calls this / what does it call, as a tree. `[lsp 1.00]` edges when a language server is running. |
| `type_hierarchy` | Supertypes and subtypes over extends/implements edges. |
| `get_dependencies` | File import graph, both directions (imports / imported-by). |
| `trace_path` | Shortest call chain between two symbols. |
| `index_status` / `reindex` | Index health and manual refresh. |

Cross-file answers are **LSP-first with a structural floor**: when a language server is available
(found on PATH or auto-acquired into a per-user cache), references/definitions/hover/call
hierarchies are exact and tagged `lsp`; everywhere else, heuristic import/name resolution answers
with a confidence score per edge. Wave-1 servers: typescript-language-server, pyright, gopls,
rust-analyzer, clangd (Java/Kotlin/C# are structural-only for now). Disable with `--no-lsp`;
disable auto-download with `--no-download`.

## Languages

**Indexing today:** TypeScript, TSX, JavaScript, Python, C, C++, Rust, Go, Java, Kotlin, C#.
**Planned:** GDScript (+ Godot `.tscn`, Unity YAML, Unreal reflection macros) — phase 6.

## Roadmap

1. ~~Structural core: scanner, SQLite+FTS5 index, TS/JS/Python extractors, first 6 tools~~ ✅
2. ~~All 11 language extractors, cross-file import resolution, call graph (`find_references`, `call_hierarchy`, `trace_path`)~~ ✅
3. ~~File watcher + incremental reindexing (scoped re-resolution, schema migrations)~~ ✅
4. ~~LSP layer wave 1 (auto-acquired ts-ls/pyright/gopls; PATH-detected rust-analyzer/clangd; precise references/definitions/hover/call hierarchy with graceful fallback)~~ ✅ — Java/Kotlin/C# servers and pinned binary downloads still to come
5. Local-embedding semantic search (`semantic_search`, hybrid BM25+vector)
6. Game-engine adapters: Godot scenes, Unity prefabs/GUIDs, Unreal reflection
7. npm publish, docs, benchmarks

## Development

```sh
npm install        # also copies grammar wasm files into grammars/
npm test           # vitest: extractor golden tests, store, scanner, MCP end-to-end
npm run lint
npm run dev serve  # run from source via tsx
```

Position convention: lines are 1-based, columns 0-based, paths root-relative with forward slashes.

## License

MIT
