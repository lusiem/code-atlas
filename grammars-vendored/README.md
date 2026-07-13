# Vendored grammar WASM builds

Grammars with no upstream `.wasm` distribution, built by us and committed here;
`scripts/copy-grammars.mjs` copies them into `grammars/` alongside the rest.

| File | Source | Built with | SHA-256 |
|---|---|---|---|
| `tree-sitter-gdscript.wasm` | [tree-sitter-gdscript 6.1.0 (npm)](https://www.npmjs.com/package/tree-sitter-gdscript) by PrestonKnopp (MIT) | `tree-sitter-cli 0.25.10 build --wasm` via `emscripten/emsdk:4.0.4` (docker), ABI 14 | `42eb46aa698cb82d4bc2f0d61c8a57cdae9ec29e42c8f632430744f890879f90` |
| `tree-sitter-solidity.wasm` | [JoranHonig/tree-sitter-solidity v1.2.3](https://github.com/JoranHonig/tree-sitter-solidity) @ `c3da7d98` (MIT) | `tree-sitter-cli 0.24.7 build --wasm` via `emscripten/emsdk:3.1.64` (docker), ABI 14 | `d9c85c2669f8969c961ddcd38ec1aa85bcba239aa22f3732a75f931bf74c4ce8` |
| `tree-sitter-nix.wasm` | [nix-community/tree-sitter-nix](https://github.com/nix-community/tree-sitter-nix) @ `3d0173d9` (MIT) | `tree-sitter-cli 0.25.10 build --wasm` via `emscripten/emsdk:3.1.64` (docker), ABI 14 | `10a66e15b62be1a59cd256abf4b48fdeac07e50c0a8e50ceb64296fcec019930` |
| `tree-sitter-dart.wasm` | [UserNobody14/tree-sitter-dart](https://github.com/UserNobody14/tree-sitter-dart) @ `be07cf71` (MIT) | `tree-sitter-cli 0.24.7 build --wasm` via `emscripten/emsdk:3.1.64` (docker), ABI 14 | `1da6d0d29303a0e8b675af72a9bca27c9ad2a2e0105cf7f65da3ef517ddac40f` |
| `tree-sitter-pascal.wasm` | [Isopod/tree-sitter-pascal](https://github.com/Isopod/tree-sitter-pascal) @ `042119ec` (MIT) | `tree-sitter-cli 0.24.7 build --wasm` via `emscripten/emsdk:3.1.64` (docker), ABI 14 | `5e55abfb8895f49956e87bd7b9a16940651ce50f45e2adacdfced71bb2bdaced` |

To rebuild: `npm pack tree-sitter-gdscript@<ver> && tar -xzf *.tgz && cd package
&& npx tree-sitter-cli build --wasm` (needs emcc or docker).
