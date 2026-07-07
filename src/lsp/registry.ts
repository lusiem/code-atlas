import type { LanguageId } from '../types.js';

/**
 * Per-language server metadata: how to find a server on PATH and, where
 * practical, how to acquire one into the managed cache. Wave 1 covers the
 * servers that install cleanly cross-platform (npm / go toolchain) or are
 * commonly already on PATH (clangd, rust-analyzer). Java/Kotlin/C# stay
 * structural-only until their runtime detection lands (JRE / .NET).
 */

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
    // release binaries need per-OS/arch checksum pinning — PATH/rustup only for now
    installHint: 'rustup component add rust-analyzer',
  },
  {
    id: 'clangd',
    languages: ['c', 'cpp'],
    detectNames: ['clangd'],
    pathArgs: ['--background-index'],
    languageIds: { c: 'c', cpp: 'cpp' },
    installHint: 'install clangd (LLVM releases or your package manager)',
  },
];

export function specForLanguage(lang: LanguageId): ServerSpec | undefined {
  return REGISTRY.find((s) => s.languages.includes(lang));
}
