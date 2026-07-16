import type { AppContext } from '../context.js';
import type { LanguageId, SymbolRow } from '../types.js';

/**
 * Near-duplicate search: cosine over the already-computed chunk vectors when
 * embeddings are ready, degrading to token-shingle Jaccard over the chunk
 * *text* (which exists before any vector does) when they are not.
 */

export interface SimilarHit {
  symbol: SymbolRow;
  score: number;
  metric: 'cosine' | 'jaccard';
}

export interface SimilarResult {
  hits: SimilarHit[];
  note: string | null;
}

const SHINGLE_SIZE = 5;
const JACCARD_MIN = 0.3;
const SHINGLE_CHUNK_CAP = 200_000;

function tokenHashes(content: string): number[] {
  const tokens = content.toLowerCase().split(/[^a-z0-9_]+/);
  const out: number[] = [];
  for (const t of tokens) {
    if (t.length === 0) continue;
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    out.push(h | 0);
  }
  return out;
}

export function shingleSet(content: string): Set<number> {
  const hashes = tokenHashes(content);
  const set = new Set<number>();
  for (let i = 0; i + SHINGLE_SIZE <= hashes.length; i++) {
    let h = 0;
    for (let j = i; j < i + SHINGLE_SIZE; j++) h = (Math.imul(h, 31) + hashes[j]!) | 0;
    set.add(h);
  }
  return set;
}

export function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const v of small) if (large.has(v)) inter++;
  return inter / (a.size + b.size - inter);
}

export async function findSimilar(
  ctx: AppContext,
  opts: {
    symbol?: SymbolRow;
    snippet?: string;
    k: number;
    minSimilarity: number;
    lang?: LanguageId;
  },
): Promise<SimilarResult | { error: string }> {
  const { store } = ctx;
  if (!ctx.config.embeddings.enabled) {
    return { error: 'find_similar_code requires embeddings.enabled — chunks are not built in this workspace' };
  }

  // ---- vector path: reuse stored chunk vectors ----
  const qv = opts.symbol
    ? store.vectorForSymbol(opts.symbol.id)
    : ((await ctx.embedder?.queryVector(opts.snippet!)) ?? null);
  if (qv) {
    const raw = store.knnChunks(qv, (opts.k + 5) * 3, opts.lang);
    const bySymbol = new Map<number, number>();
    for (const hit of raw) {
      if (opts.symbol && hit.symbolId === opts.symbol.id) continue;
      const prev = bySymbol.get(hit.symbolId);
      if (prev === undefined || hit.score > prev) bySymbol.set(hit.symbolId, hit.score);
    }
    const hits: SimilarHit[] = [];
    for (const [symbolId, score] of bySymbol) {
      if (score < opts.minSimilarity) continue;
      const symbol = store.getSymbolById(symbolId);
      if (symbol) hits.push({ symbol, score, metric: 'cosine' });
    }
    hits.sort((a, b) => b.score - a.score);
    return { hits: hits.slice(0, opts.k), note: null };
  }

  // ---- shingle fallback: chunk text exists before vectors do ----
  const queryContent = opts.symbol ? store.chunkContentForSymbol(opts.symbol.id) : opts.snippet!;
  if (!queryContent) {
    return { error: `${opts.symbol!.qualifiedName} has no indexed chunk (too small to embed) — pass its source as snippet instead` };
  }
  const { chunks: total } = store.embeddingStats();
  if (total > SHINGLE_CHUNK_CAP) {
    return { error: `embeddings not ready and the workspace is too large for the text fallback (${total} chunks) — retry once embedding coverage completes` };
  }
  const querySet = shingleSet(queryContent);
  if (querySet.size === 0) return { hits: [], note: 'query too short to shingle' };

  const best = new Map<number, number>();
  for (const chunk of store.allChunks(opts.lang)) {
    if (opts.symbol && chunk.symbolId === opts.symbol.id) continue;
    const j = jaccard(querySet, shingleSet(chunk.content));
    if (j < JACCARD_MIN) continue;
    const prev = best.get(chunk.symbolId);
    if (prev === undefined || j > prev) best.set(chunk.symbolId, j);
  }
  const hits: SimilarHit[] = [];
  for (const [symbolId, score] of best) {
    const symbol = store.getSymbolById(symbolId);
    if (symbol) hits.push({ symbol, score, metric: 'jaccard' });
  }
  hits.sort((a, b) => b.score - a.score);
  return {
    hits: hits.slice(0, opts.k),
    note: 'embeddings not ready — token-shingle similarity (weaker signal); results sharpen once embedding coverage completes',
  };
}
