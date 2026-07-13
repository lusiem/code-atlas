# Grammar acquisition

Grammar `.wasm` files live in `grammars/` (gitignored; shipped in the npm tarball).
`npm install` / `npm run grammars` assembles them from three sources
(`scripts/copy-grammars.mjs`):

1. **@vscode/tree-sitter-wasm** — typescript, tsx, javascript, python, cpp,
   rust, go, java, c_sharp, php, ruby. These builds are ABI-compatible with our
   pinned `web-tree-sitter` (verified by the test suite — if a bump breaks
   compatibility, `Language.load` fails loudly in tests).
2. **Pinned GitHub release downloads**, verified against SHA-256 checksums
   hard-coded in the script — c (`tree-sitter/tree-sitter-c`), kotlin
   (`fwcd/tree-sitter-kotlin`), lua and zig (`tree-sitter-grammars/*`), swift
   (`alex-pinkus/tree-sitter-swift`), scala (`tree-sitter/tree-sitter-scala`),
   and terraform (`tree-sitter-grammars/tree-sitter-hcl`'s terraform build).
   Downloads are best-effort: if one fails, that language simply isn't indexed
   and the script says so.
3. **`grammars-vendored/`** — wasm we build ourselves because upstream ships no
   binary: gdscript, solidity, nix, dart, pascal. Committed to the repo with
   build provenance (source commit, CLI + emsdk versions, ABI, SHA-256) in
   `grammars-vendored/README.md`.

Vue and Svelte have **no grammar of their own**: the loader aliases them to the
typescript grammar (`GRAMMAR_ALIAS` in `src/parsing/loader.ts`) and an
offset-preserving preprocess blanks everything outside `<script>` blocks
(`src/parsing/langs/sfc.ts`).

Godot's `.tscn`/`.tres` scene formats are hand-parsed (`src/engines/godot.ts`) —
no grammar needed.

> **Do not** source grammars from the `tree-sitter-wasms` npm package: its binaries
> are built against an old tree-sitter ABI and fail with a dylink metadata error
> under web-tree-sitter ≥ 0.25.

## Version bumps

When bumping a downloaded grammar: update the release URL and the SHA-256 in
`scripts/copy-grammars.mjs` together, re-run `npm run grammars`, then run the
test suite (extractor tests catch node-type renames; `Language.load` catches
ABI breaks).
