import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cacheRoot } from '../cache.js';
import { runCommand } from '../lsp/acquire.js';

/**
 * The ONNX embedding runtime is ~220 MB installed (onnxruntime-node), so it
 * is NOT a dependency of this package: it gets npm-installed into the user
 * cache on first semantic use, exactly like auto-acquired language servers.
 */
const RUNTIME_PKG = '@huggingface/transformers';
const RUNTIME_VERSION = '4.2.0';

export interface ModelPreset {
  /** Name as configured ('code', 'fast', or a raw HF model id). */
  name: string;
  hfId: string;
  /** Prepended to queries (not documents); some models are asymmetric. */
  queryPrefix: string;
}

const PRESETS: Record<string, Omit<ModelPreset, 'name'>> = {
  // code-tuned, 768-dim: sharp relevant/irrelevant separation on code (default)
  code: { hfId: 'jinaai/jina-embeddings-v2-base-code', queryPrefix: '' },
  // general-purpose, 384-dim: ~4x faster embedding, mushier ranking
  fast: {
    hfId: 'Xenova/bge-small-en-v1.5',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
  },
};

export function presetFor(name: string): ModelPreset {
  const preset = PRESETS[name];
  return preset ? { name, ...preset } : { name, hfId: name, queryPrefix: '' };
}

export function runtimeDir(): string {
  return join(cacheRoot(), 'embed-runtime');
}

export function modelsDir(): string {
  return join(cacheRoot(), 'models');
}

export function runtimeInstalled(): boolean {
  return existsSync(join(runtimeDir(), 'node_modules', RUNTIME_PKG, 'package.json'));
}

/** True when the model files are already in the local cache (no download needed). */
export function modelCached(preset: ModelPreset): boolean {
  return existsSync(join(modelsDir(), ...preset.hfId.split('/')));
}

export interface EmbeddingBackend {
  hfId: string;
  dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}

interface TransformersModule {
  env: {
    cacheDir: string;
    allowRemoteModels: boolean;
  };
  pipeline(
    task: string,
    model: string,
    options: { dtype: string },
  ): Promise<FeatureExtractor>;
}

interface FeatureExtractor {
  (texts: string[], options: { pooling: string; normalize: boolean }): Promise<{
    data: Float32Array;
    dims: number[];
  }>;
  dispose(): Promise<void>;
}

async function loadRuntime(download: boolean): Promise<TransformersModule | null> {
  const dir = runtimeDir();
  if (!runtimeInstalled()) {
    if (!download) return null;
    console.error(`[code-atlas] installing embedding runtime (${RUNTIME_PKG}, one-time ~220 MB)…`);
    mkdirSync(dir, { recursive: true });
    const ok = await runCommand('npm', [
      'install',
      '--prefix', dir,
      '--no-audit', '--no-fund', '--loglevel=error',
      `${RUNTIME_PKG}@${RUNTIME_VERSION}`,
    ]);
    if (!ok || !runtimeInstalled()) return null;
  }
  const pkgDir = join(dir, 'node_modules', RUNTIME_PKG);
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
    exports?: { node?: { import?: { default?: string } } };
    module?: string;
    main?: string;
  };
  const entry = pkg.exports?.node?.import?.default ?? pkg.module ?? pkg.main;
  if (!entry) return null;
  return (await import(pathToFileURL(join(pkgDir, entry)).href)) as TransformersModule;
}

/**
 * Load an embedding backend, downloading runtime and/or model when allowed.
 * Null = semantic search stays keyword-only (caller reports why).
 */
export async function createBackend(
  preset: ModelPreset,
  opts: { download: boolean },
): Promise<EmbeddingBackend | null> {
  const rt = await loadRuntime(opts.download);
  if (rt === null) return null;
  if (!opts.download && !modelCached(preset)) return null;

  rt.env.cacheDir = modelsDir();
  rt.env.allowRemoteModels = opts.download;
  if (!modelCached(preset)) {
    console.error(`[code-atlas] downloading embedding model ${preset.hfId} (one-time)…`);
  }
  const extractor = await rt.pipeline('feature-extraction', preset.hfId, { dtype: 'q8' });

  const backend: EmbeddingBackend = {
    hfId: preset.hfId,
    dims: 0, // discovered on first embed
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out = await extractor(texts, { pooling: 'mean', normalize: true });
      const dims = out.dims[out.dims.length - 1]!;
      backend.dims = dims;
      const vectors: Float32Array[] = [];
      for (let i = 0; i < texts.length; i++) {
        vectors.push(out.data.slice(i * dims, (i + 1) * dims));
      }
      return vectors;
    },
    async dispose(): Promise<void> {
      await extractor.dispose();
    },
  };
  return backend;
}
