# Grammar acquisition

Grammar `.wasm` files live in `grammars/` (gitignored; shipped in the npm tarball).
`npm install` / `npm run grammars` copies them from `@vscode/tree-sitter-wasm`,
whose builds are ABI-compatible with our pinned `web-tree-sitter` (verified by the
test suite — if a bump breaks compatibility, `Language.load` fails loudly in tests).

> **Do not** source grammars from the `tree-sitter-wasms` npm package: its binaries
> are built against an old tree-sitter ABI and fail with a dylink metadata error
> under web-tree-sitter ≥ 0.25.

## Currently bundled (from @vscode/tree-sitter-wasm)

typescript, tsx, javascript, python, cpp, rust, go, java, c_sharp

## Pending

| Language | Plan |
|---|---|
| c | Official `tree-sitter/tree-sitter-c` GitHub release attaches a `.wasm`; add a pinned, checksummed download to `scripts/copy-grammars.mjs`. Until then `.c` files are not indexed (do **not** parse C with the cpp grammar — close, but wrong on real-world headers). |
| kotlin | `fwcd/tree-sitter-kotlin` — build wasm in CI with `tree-sitter build --wasm` (emscripten container) or vendor a checked build. |
| gdscript | `PrestonKnopp/tree-sitter-gdscript` — same approach as kotlin. Phase 6. |
| godot_resource | `PrestonKnopp/tree-sitter-godot-resource` for `.tscn`/`.tres`. Phase 6 (may use a hand-rolled parser instead; the format is simple). |
