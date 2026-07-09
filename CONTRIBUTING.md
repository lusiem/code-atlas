# Contributing to code-atlas

## Setup

```sh
npm install     # also assembles grammars/ (prebuilt + pinned downloads + vendored)
npm test        # vitest — no network, no language servers, no model downloads needed
npm run lint
npm run dev serve --root /some/repo   # run from source
```

Node >= 22. Native deps (better-sqlite3, sqlite-vec) ship prebuilds for
win/mac/linux; no toolchain required.

## Ground rules

- **Conventions:** lines are 1-based, columns 0-based, paths root-relative with forward
  slashes — everywhere: database, tools, tests. LSP speaks 0-based lines; convert at the
  boundary (`src/lsp/overlay.ts`).
- **Provenance honesty:** every cross-file answer is tagged with where it came from
  (`lsp` vs `index`) and a confidence. Never present a heuristic result as exact.
- **Token economy:** tools return `path:line` text, paginated, no unrequested source dumps.
- **Graceful degradation:** a missing runtime/server/model must never break structural
  answers, and the degradation must be visible in `index_status`. Nothing slow may run on
  a tool-call path: MCP clients time out at 60 s (see the 8 s LSP start budget and the
  background embedder for the pattern).
- CI must stay green on win/mac/linux; Windows is where path and native-dep bugs live.

## Adding a language

1. Grammar wasm into `grammars/` via `scripts/copy-grammars.mjs` — prefer
   `@vscode/tree-sitter-wasm`, else a pinned SHA-256 download, else build it yourself
   (docker + `tree-sitter build --wasm`) and vendor it in `grammars-vendored/` with
   provenance in that folder's README. ABI must be <= the shipped web-tree-sitter's.
2. Register the id + extensions in `src/languages.ts` and `src/types.ts`.
3. Extractor in `src/parsing/langs/<lang>.ts`: a tags-style symbol query
   (`@def.<kind>` + `@name`), an occurrence query (`@call`/`@write`/`@ref`), import
   extraction, and hooks (docs, bases, reclassify). Study `python.ts` (field names) or
   `kotlin.ts` (positional-only grammars).
4. Import resolution branch in `src/graph/resolver.ts`, plus a per-language
   `UBIQUITOUS_NAMES` set (builtins that would otherwise attract thousands of false
   references — check a real repo before skipping this).
5. Golden tests in `test/extractor-langs.test.ts`; then index a real repo and eyeball
   `find_references` on a hot symbol.

## Adding a language server

Add a `ServerSpec` in `src/lsp/registry.ts`. Acquisition kinds: `npm`, `go`,
`binary` (pinned per-platform URL + SHA-256 — download the assets, hash them yourself,
pin what you verified), `dotnet-tool`, `jdtls`. Gate on runtime detection
(`findJava`/`findDotnet`) rather than failing at spawn. PATH always wins over the cache.

Servers we can't spawn (the Godot editor's built-in LS) use `attach: { host, port }`
instead: connect failures are a normal condition, retried on demand and never escalated
to `failed`, and dispose only closes the socket — never send `shutdown`/`exit` to a
process we don't own. Deterministic tests fake the endpoint (`test/helpers/fake-tcp-lsp.ts`);
the real editor is exercised nightly (`test/godot-editor.test.ts`, self-skipping without
a `GODOT_BIN`).

## Benchmarks

`node scripts/bench.mjs <repo> [--assert]` — cold index + warm p50/p95 per tool. CI runs
it against a pinned vuejs/core clone; keep the bounds loose (shared runners) and the
numbers honest.
