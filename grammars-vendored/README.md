# Vendored grammar WASM builds

Grammars with no upstream `.wasm` distribution, built by us and committed here;
`scripts/copy-grammars.mjs` copies them into `grammars/` alongside the rest.

| File | Source | Built with | SHA-256 |
|---|---|---|---|
| `tree-sitter-gdscript.wasm` | [tree-sitter-gdscript 6.1.0 (npm)](https://www.npmjs.com/package/tree-sitter-gdscript) by PrestonKnopp (MIT) | `tree-sitter-cli 0.25.10 build --wasm` via `emscripten/emsdk:4.0.4` (docker), ABI 14 | `42eb46aa698cb82d4bc2f0d61c8a57cdae9ec29e42c8f632430744f890879f90` |

To rebuild: `npm pack tree-sitter-gdscript@<ver> && tar -xzf *.tgz && cd package
&& npx tree-sitter-cli build --wasm` (needs emcc or docker).
