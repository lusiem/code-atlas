import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const configFileSchema = z
  .object({
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
    maxFileBytes: z.number().int().positive().default(2_000_000),
    watch: z.boolean().default(true),
    lsp: z
      .object({
        enabled: z.boolean().default(true),
        download: z.boolean().default(true),
      })
      .partial()
      .default({}),
    embeddings: z
      .object({
        enabled: z.boolean().default(true),
        download: z.boolean().default(true),
        model: z.string().default('code'),
      })
      .partial()
      .default({}),
  })
  .partial();

export interface AtlasConfig {
  /** Absolute workspace root. */
  root: string;
  /** Extra include globs (on top of language extension detection). Reserved for future use. */
  include: string[];
  /** Extra exclude patterns, .gitignore syntax, relative to root. */
  exclude: string[];
  /** Files larger than this are skipped (generated bundles, minified JS). */
  maxFileBytes: number;
  /** Watch the workspace and reindex on change while serving (default true). */
  watch: boolean;
  /** LSP layer: precise answers overlaid on the structural index. */
  lsp: { enabled: boolean; download: boolean };
  /** Local embedding layer backing semantic_search. model: 'code' | 'fast' | HF id. */
  embeddings: { enabled: boolean; download: boolean; model: string };
  /** Absolute path of the SQLite index. */
  dbPath: string;
  /** Directory holding the index and other per-project state. */
  stateDir: string;
}

export const CONFIG_FILE_NAME = 'code-atlas.json';

export function loadConfig(rootInput: string): AtlasConfig {
  const root = resolve(rootInput);
  let fileValues: z.infer<typeof configFileSchema> = {};
  const configPath = join(root, CONFIG_FILE_NAME);
  if (existsSync(configPath)) {
    const parsed = configFileSchema.safeParse(JSON.parse(readFileSync(configPath, 'utf8')));
    if (!parsed.success) {
      throw new Error(`Invalid ${CONFIG_FILE_NAME}: ${parsed.error.message}`);
    }
    fileValues = parsed.data;
  }
  const stateDir = join(root, '.code-atlas');
  return {
    root,
    include: fileValues.include ?? [],
    exclude: fileValues.exclude ?? [],
    maxFileBytes: fileValues.maxFileBytes ?? 2_000_000,
    watch: fileValues.watch ?? true,
    lsp: {
      enabled: fileValues.lsp?.enabled ?? true,
      download: fileValues.lsp?.download ?? true,
    },
    embeddings: {
      enabled: fileValues.embeddings?.enabled ?? true,
      download: fileValues.embeddings?.download ?? true,
      model: fileValues.embeddings?.model ?? 'code',
    },
    stateDir,
    dbPath: join(stateDir, 'index.db'),
  };
}
