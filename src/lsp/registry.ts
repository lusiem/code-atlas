import type { LanguageId } from '../types.js';

/**
 * Per-language server metadata: how to find a server on PATH and, where
 * practical, how to acquire one into the managed cache. Acquisition paths:
 * npm install, go install, pinned+checksummed binary downloads, dotnet
 * tools, and the JDT LS tarball (needs a Java 21+ runtime detected).
 */

/** `${platform}-${arch}`, or 'any' for platform-independent (JVM) archives. */
export type PlatformKey =
  | 'win32-x64'
  | 'win32-arm64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'darwin-x64'
  | 'darwin-arm64';

export interface BinaryAsset {
  url: string;
  /** SHA-256 of the archive; downloads that do not match are discarded. */
  sha256: string;
  archive: 'zip' | 'gz' | 'tar.gz';
  /** Executable path inside the extracted tree ('gz' = name to write). */
  bin: string;
  /** Windows override of bin (…\.exe, …\.bat). */
  binWin?: string;
}

export type AcquireSpec =
  | {
      kind: 'npm';
      /** Exact package specs installed into <cache>/<id>/node_modules. */
      packages: string[];
      /** Entry script under node_modules, launched with the current node. */
      entry: string;
      args: string[];
      /** Extra initializationOptions given the install dir (e.g. tsserver path). */
      initOptions?: (installDir: string) => unknown;
    }
  | {
      kind: 'go';
      /** Module path with version, `go install`-ed with GOBIN=<cache>/bin. */
      module: string;
      bin: string;
      args: string[];
    }
  | {
      kind: 'binary';
      assets: Partial<Record<PlatformKey | 'any', BinaryAsset>>;
      args: string[];
      /** Launch depends on a runtime we must detect first. */
      requires?: 'java';
    }
  | {
      kind: 'dotnet-tool';
      /** NuGet tool package, pinned version (integrity handled by nuget). */
      package: string;
      version: string;
      bin: string;
      args: string[];
    }
  | {
      kind: 'jdtls';
      url: string;
      sha256: string;
    };

export interface ServerSpec {
  id: string;
  languages: LanguageId[];
  /** Executable names probed on PATH (platform extensions added on Windows). */
  detectNames: string[];
  /** Args when launching a PATH-found binary. */
  pathArgs: string[];
  /** LSP languageId per indexed language. */
  languageIds: Partial<Record<LanguageId, string>>;
  acquire?: AcquireSpec;
  /** Shown in index_status when the server is unavailable. */
  installHint: string;
  /** Test hook: launch this command directly, skipping detection/acquisition. */
  launch?: { command: string; args: string[]; initializationOptions?: unknown };
}

export const REGISTRY: ServerSpec[] = [
  {
    id: 'typescript-language-server',
    languages: ['typescript', 'tsx', 'javascript'],
    detectNames: ['typescript-language-server'],
    pathArgs: ['--stdio'],
    languageIds: { typescript: 'typescript', tsx: 'typescriptreact', javascript: 'javascript' },
    acquire: {
      kind: 'npm',
      packages: ['typescript-language-server@^4', 'typescript@^5'],
      entry: 'typescript-language-server/lib/cli.mjs',
      args: ['--stdio'],
      initOptions: (dir) => ({ tsserver: { path: `${dir}/node_modules/typescript/lib` } }),
    },
    installHint: 'npm i -g typescript-language-server typescript',
  },
  {
    id: 'pyright',
    languages: ['python'],
    detectNames: ['pyright-langserver', 'basedpyright-langserver'],
    pathArgs: ['--stdio'],
    languageIds: { python: 'python' },
    acquire: {
      kind: 'npm',
      packages: ['pyright@^1'],
      entry: 'pyright/langserver.index.js',
      args: ['--stdio'],
    },
    installHint: 'npm i -g pyright',
  },
  {
    id: 'gopls',
    languages: ['go'],
    detectNames: ['gopls'],
    pathArgs: [],
    languageIds: { go: 'go' },
    acquire: { kind: 'go', module: 'golang.org/x/tools/gopls@latest', bin: 'gopls', args: [] },
    installHint: 'go install golang.org/x/tools/gopls@latest',
  },
  {
    id: 'rust-analyzer',
    languages: ['rust'],
    detectNames: ['rust-analyzer'],
    pathArgs: [],
    languageIds: { rust: 'rust' },
    acquire: {
      kind: 'binary',
      args: [],
      // pinned release 2026-07-06; checksums computed from the downloaded assets
      assets: {
        'win32-x64': {
          url: 'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-06/rust-analyzer-x86_64-pc-windows-msvc.zip',
          sha256: 'b046120af10d0cb7c735bbd377a53007d97048666fe967e95ea88a9fc177fa09',
          archive: 'zip',
          bin: 'rust-analyzer.exe',
        },
        'linux-x64': {
          url: 'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-06/rust-analyzer-x86_64-unknown-linux-gnu.gz',
          sha256: '2fb596e12676e512de5dbf1c322dd591127ee089a1cca47995605593f2fc8850',
          archive: 'gz',
          bin: 'rust-analyzer',
        },
        'linux-arm64': {
          url: 'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-06/rust-analyzer-aarch64-unknown-linux-gnu.gz',
          sha256: '7e2627d96c6f1614115d212b61fd5f8dc9279853054b800f2b023c883e3ae056',
          archive: 'gz',
          bin: 'rust-analyzer',
        },
        'darwin-x64': {
          url: 'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-06/rust-analyzer-x86_64-apple-darwin.gz',
          sha256: '3a6bc5b42c27d3f8d308dacb25fdbe9bba0577be2970500cdb936e53c21c3496',
          archive: 'gz',
          bin: 'rust-analyzer',
        },
        'darwin-arm64': {
          url: 'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-06/rust-analyzer-aarch64-apple-darwin.gz',
          sha256: '0fb2229496105666460d22d062a55e154c862bb8004c464a38c6ffaff6fd68fe',
          archive: 'gz',
          bin: 'rust-analyzer',
        },
      },
    },
    installHint: 'rustup component add rust-analyzer',
  },
  {
    id: 'clangd',
    languages: ['c', 'cpp'],
    detectNames: ['clangd'],
    pathArgs: ['--background-index'],
    languageIds: { c: 'c', cpp: 'cpp' },
    acquire: {
      kind: 'binary',
      args: ['--background-index'],
      // clangd 22.1.6 (no linux-arm64 upstream — PATH-only there)
      assets: {
        'win32-x64': {
          url: 'https://github.com/clangd/clangd/releases/download/22.1.6/clangd-windows-22.1.6.zip',
          sha256: 'ce54f16e0b4fd76d450eeda9664420b195360b73febcfe40e661108fa57f2ce1',
          archive: 'zip',
          bin: 'clangd_22.1.6/bin/clangd',
          binWin: 'clangd_22.1.6/bin/clangd.exe',
        },
        'linux-x64': {
          url: 'https://github.com/clangd/clangd/releases/download/22.1.6/clangd-linux-22.1.6.zip',
          sha256: 'a9c77443af2e447ed467e84771848d3a6ac1c56f84bcfcde717e66318de77cfa',
          archive: 'zip',
          bin: 'clangd_22.1.6/bin/clangd',
        },
        'darwin-x64': {
          url: 'https://github.com/clangd/clangd/releases/download/22.1.6/clangd-mac-22.1.6.zip',
          sha256: '631aef462556cbd74e0ebaae1778a38d1997d0ba3371652ca54f82652a179e7d',
          archive: 'zip',
          bin: 'clangd_22.1.6/bin/clangd',
        },
        'darwin-arm64': {
          url: 'https://github.com/clangd/clangd/releases/download/22.1.6/clangd-mac-22.1.6.zip',
          sha256: '631aef462556cbd74e0ebaae1778a38d1997d0ba3371652ca54f82652a179e7d',
          archive: 'zip',
          bin: 'clangd_22.1.6/bin/clangd',
        },
      },
    },
    installHint: 'install clangd (LLVM releases or your package manager)',
  },
  {
    id: 'jdtls',
    languages: ['java'],
    detectNames: ['jdtls'],
    pathArgs: [],
    languageIds: { java: 'java' },
    acquire: {
      kind: 'jdtls',
      // 1.60.0 milestone; sha256 matches eclipse's published .sha256
      url: 'https://download.eclipse.org/jdtls/milestones/1.60.0/jdt-language-server-1.60.0-202606262232.tar.gz',
      sha256: 'e94c303d8198f977930803582738771fd18c52c5492878410bf222b1aa81ef1d',
    },
    installHint: 'requires a Java 21+ runtime on PATH (or JAVA_HOME); jdtls is then auto-downloaded',
  },
  {
    id: 'kotlin-language-server',
    languages: ['kotlin'],
    detectNames: ['kotlin-language-server'],
    pathArgs: [],
    languageIds: { kotlin: 'kotlin' },
    acquire: {
      kind: 'binary',
      args: [],
      requires: 'java',
      // fwcd/kotlin-language-server 1.3.13 — JVM zip, platform-independent
      // (JetBrains' kotlin-lsp is still pre-alpha with no stable release assets)
      assets: {
        any: {
          url: 'https://github.com/fwcd/kotlin-language-server/releases/download/1.3.13/server.zip',
          sha256: '4fe7d71d087b307c7869036171bd9d8c6a4284cd7c25b89098b0a24eb2d9b6d2',
          archive: 'zip',
          bin: 'server/bin/kotlin-language-server',
          binWin: 'server/bin/kotlin-language-server.bat',
        },
      },
    },
    installHint: 'requires a Java runtime; kotlin-language-server is then auto-downloaded',
  },
  {
    id: 'csharp-ls',
    languages: ['c_sharp'],
    detectNames: ['csharp-ls'],
    pathArgs: [],
    languageIds: { c_sharp: 'csharp' },
    acquire: {
      kind: 'dotnet-tool',
      package: 'csharp-ls',
      version: '0.25.0',
      bin: 'csharp-ls',
      args: [],
    },
    installHint: 'requires the .NET SDK; csharp-ls is then installed as a dotnet tool',
  },
];

export function specForLanguage(lang: LanguageId): ServerSpec | undefined {
  return REGISTRY.find((s) => s.languages.includes(lang));
}
