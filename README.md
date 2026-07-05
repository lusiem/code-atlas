# code-atlas

**Multi-language code intelligence MCP server** — gives Claude Code (and any MCP client) a structured view of your codebase instead of raw text: symbol search, file outlines, AST pattern queries, and (coming) call graphs, precise LSP-backed references, semantic search, and game-engine asset understanding.

Instead of grepping and reading whole files, the model asks questions like *"outline this file"*, *"where is `parseConfig` defined?"*, or *"find every `await` inside a loop"* — and gets compact, token-efficient answers backed by a persistent tree-sitter index.

> **Status: early development.** Phase 1 (structural indexing core) is functional for TypeScript, TSX, JavaScript, and Python. See the roadmap below.

## How it works

```
your repo ──scan (gitignore-aware)──> tree-sitter parse ──> SQLite index (symbols, imports, FTS5)
                                                                   │
Claude Code ◄──────────── MCP tools over stdio ────────────────────┘
```

- **Persistent index** at `<repo>/.code-atlas/index.db` (self-gitignored), incrementally refreshed by content hash.
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
node dist/index.js index [--root <path>]   # one-shot index build (debugging / warm-up)
node dist/index.js serve [--root <path>]   # MCP server on stdio
```

## Tools

| Tool | What it answers |
|---|---|
| `project_overview` | What is this project? Languages, sizes, index freshness. Call first. |
| `search_symbols` | Where is *X* defined? FTS + fuzzy over names and doc comments, filterable by kind/language/path. |
| `get_file_outline` | What's in this file? Hierarchical signatures without reading source. |
| `get_symbol_info` | Everything about one symbol (by id, position, or name) incl. docs and source. |
| `ast_query` | Raw tree-sitter S-expression queries — structural search regex can't do. |
| `index_status` / `reindex` | Index health and manual refresh. |

## Languages

**Indexing today:** TypeScript, TSX, JavaScript, Python.
**Grammar bundled, extractor pending:** C++, Rust, Go, Java, C#.
**Planned:** C, Kotlin, GDScript (+ Godot `.tscn`, Unity YAML, Unreal reflection macros).

## Roadmap

1. ~~Structural core: scanner, SQLite+FTS5 index, TS/JS/Python extractors, first 6 tools~~ ✅
2. All 11 language extractors, cross-file import resolution, call graph (`find_references`, `call_hierarchy`, `trace_path`)
3. File watcher + incremental reindexing
4. LSP layer (auto-acquired language servers; precise definitions/references/hover with graceful fallback)
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
