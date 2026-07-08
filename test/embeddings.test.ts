import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type AtlasConfig } from '../src/config.js';
import { prepareSchema } from '../src/db/schema.js';
import { Store } from '../src/db/store.js';
import { buildChunks } from '../src/embeddings/chunker.js';
import { Embedder } from '../src/embeddings/embedder.js';
import type { EmbeddingBackend } from '../src/embeddings/model.js';
import { semanticSearch } from '../src/embeddings/search.js';
import { Indexer } from '../src/indexer/indexer.js';
import { extractFile } from '../src/parsing/extractor.js';
import { extractorFor } from '../src/parsing/registry.js';
import type { AppContext } from '../src/context.js';

/**
 * Deterministic fake model: dimension i is 1 when the text contains KEYWORDS[i],
 * then the vector is L2-normalized — no downloads, stable ranking.
 */
const KEYWORDS = ['shorten', 'truncate', 'resolve', 'geometry'];

function fakeVector(text: string): Float32Array {
  const v = new Float32Array(KEYWORDS.length);
  const lower = text.toLowerCase();
  KEYWORDS.forEach((kw, i) => {
    if (lower.includes(kw)) v[i] = 1;
  });
  let norm = Math.hypot(...v);
  if (norm === 0) {
    v[v.length - 1] = 1;
    norm = 1;
  }
  for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

function fakeBackend(hfId = 'fake/model'): EmbeddingBackend {
  return {
    hfId,
    dims: KEYWORDS.length,
    embed: (texts) => Promise.resolve(texts.map(fakeVector)),
    dispose: () => Promise.resolve(),
  };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const A_TS = `/** Cuts a string down to a maximum length. */
export function truncateText(s: string, max: number): string {
  // shorten the string to max characters
  return s.length > max ? s.slice(0, max) : s;
}
`;

const B_TS = `/** Resolves import specifiers to files. */
export function resolveImports(specs: string[]): string[] {
  return specs.map((s) => s.trim());
}

const helperLimit = 10;
`;

let root: string;
let store: Store;
let indexer: Indexer;
let config: AtlasConfig;
let embedder: Embedder;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'atlas-embed-'));
  writeFileSync(join(root, 'a.ts'), A_TS);
  writeFileSync(join(root, 'b.ts'), B_TS);
  config = loadConfig(root);
  store = new Store(':memory:');
  indexer = new Indexer(config, store);
  await indexer.run();
});

afterAll(async () => {
  await embedder?.shutdown();
  store?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('chunker', () => {
  it('chunks callables with body and containers with members, skipping variables', async () => {
    const source = `/** doc */
export class Widget {
  render(): void { draw(); }
}
const LIMIT = 5;
`;
    const extraction = await extractFile(extractorFor('typescript')!, source);
    const chunks = buildChunks(extraction, source, 'src/widget.ts');
    const byName = new Map(chunks.map((c) => [extraction.symbols[c.symbolIndex]!.name, c]));

    const cls = byName.get('Widget')!;
    expect(cls.content).toContain('class Widget');
    expect(cls.content).toContain('members: render');
    expect(cls.content).toContain('src/widget.ts');

    const method = byName.get('render')!;
    expect(method.content).toContain('draw();'); // body included for leaves
    expect(method.textHash).toMatch(/^[0-9a-f]{40}$/);

    expect(byName.has('LIMIT')).toBe(false);
  });
});

describe('embedder + chunk store', () => {
  it('indexing produced pending chunks', () => {
    const { chunks, embedded } = store.embeddingStats();
    expect(chunks).toBeGreaterThanOrEqual(2); // truncateText, resolveImports
    expect(embedded).toBe(0);
  });

  it('background loop embeds the backlog with the injected backend', async () => {
    embedder = new Embedder(store, {
      enabled: true,
      download: false, // must not matter: backendFactory bypasses acquisition
      model: 'code',
      backendFactory: () => Promise.resolve(fakeBackend()),
    });
    embedder.activate('startup');
    await until(() => {
      const s = store.embeddingStats();
      return s.chunks > 0 && s.embedded === s.chunks;
    });
    expect(embedder.phase).toBe('ready');
    expect(store.getMeta('embedding_model')).toBe('fake/model');
    expect(store.getMeta('embedding_dims')).toBe(String(KEYWORDS.length));
  });

  it('an unchanged symbol keeps its vector across a file edit (hash reuse)', async () => {
    // append a new function; truncateText's chunk text is untouched
    writeFileSync(join(root, 'a.ts'), A_TS + `\nexport function pad(s: string): string { return s + ' '; }\n`);
    await indexer.applyChanges(['a.ts']);
    const pending = store.pendingChunks(100);
    expect(pending.length).toBe(1); // only pad() needs embedding
    expect(pending[0]!.content).toContain('function pad');

    embedder.nudge();
    await until(() => store.pendingChunks(1).length === 0);
  });

  it('knnChunks ranks by cosine similarity in both scan modes', () => {
    const query = fakeVector('shorten truncate');
    const viaAccel = store.knnChunks(query, 3);
    expect(viaAccel.length).toBeGreaterThan(0);

    // force the JS fallback and compare
    Object.defineProperty(store, 'vecAccel', { value: false });
    const viaJs = store.knnChunks(query, 3);
    Object.defineProperty(store, 'vecAccel', { value: true });

    expect(viaJs[0]!.chunkId).toBe(viaAccel[0]!.chunkId);
    expect(viaJs[0]!.score).toBeCloseTo(viaAccel[0]!.score, 5);
    const top = store.getSymbolById(viaAccel[0]!.symbolId)!;
    expect(top.name).toBe('truncateText');
  });

  it('switching models wipes vectors and re-embeds', async () => {
    const other = new Embedder(store, {
      enabled: true,
      download: false,
      model: 'other',
      backendFactory: () => Promise.resolve(fakeBackend('fake/other')),
    });
    other.activate('startup');
    await until(() => store.getMeta('embedding_model') === 'fake/other');
    await until(() => {
      const s = store.embeddingStats();
      return s.embedded === s.chunks;
    });
    await other.shutdown();
    // hand meta back to the main embedder's model for later tests
    store.setMeta('embedding_model', 'fake/model');
  });
});

describe('semanticSearch (hybrid)', () => {
  function ctx(): AppContext {
    return { config, store, indexer, embedder };
  }

  it('finds symbols by behavior words that appear nowhere in the name', async () => {
    // 'shorten' exists only in a body comment — FTS can't see it, vectors can
    const result = await semanticSearch(ctx(), 'shorten', 5);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]!.symbol.name).toBe('truncateText');
    expect(result.hits[0]!.sources).toBe('vec');
    expect(result.hits[0]!.cosine).toBeGreaterThan(0.5);
  });

  it('fuses keyword and vector rankings', async () => {
    const result = await semanticSearch(ctx(), 'resolveImports', 5);
    const top = result.hits[0]!;
    expect(top.symbol.name).toBe('resolveImports');
    expect(top.sources).toBe('vec+fts');
  });

  it('reports keyword-only when no embedder is present', async () => {
    const bare: AppContext = { config, store, indexer };
    const result = await semanticSearch(bare, 'resolveImports', 5);
    expect(result.note).toContain('embeddings disabled');
    expect(result.hits[0]!.sources).toBe('fts');
  });
});

describe('schema v2 -> v3 upgrade', () => {
  it('forces a rebuild: an in-place migration would leave chunks empty forever', () => {
    const s = new Store(':memory:');
    s.db.exec(`DROP TABLE chunk_vectors; DROP TABLE chunks;`);
    s.db.prepare(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`).run();
    expect(prepareSchema(s.db)).toBe('rebuild');
    s.close();
  });
});
