import type { AppContext } from '../context.js';
import type { LanguageId, SymbolRow } from '../types.js';

export interface SemanticHit {
  symbol: SymbolRow;
  /** Reciprocal-rank-fusion score (relative ordering only). */
  score: number;
  /** Best cosine similarity among this symbol's chunks, when vectors ran. */
  cosine: number | null;
  sources: 'vec+fts' | 'vec' | 'fts';
}

export interface SemanticResult {
  hits: SemanticHit[];
  /** Set when results are keyword-only or partial — surfaced to the caller. */
  note: string | null;
}

const CANDIDATES = 50;
const RRF_K = 60;

/**
 * Hybrid natural-language search: FTS5 BM25 over symbol names/docs fused
 * (reciprocal rank) with cosine KNN over chunk embeddings. Degrades to
 * keyword-only whenever vectors aren't ready, and says so.
 */
export async function semanticSearch(
  ctx: AppContext,
  query: string,
  k: number,
  lang?: LanguageId,
): Promise<SemanticResult> {
  const { store, embedder } = ctx;
  const ftsRows = store.searchSymbols(query, { limit: CANDIDATES, offset: 0, lang });

  let note: string | null = null;
  let vecHits: Array<{ symbolId: number; score: number }> = [];
  if (!embedder || embedder.phase === 'disabled') {
    note = 'keyword-only: embeddings disabled';
  } else {
    const qv = await embedder.queryVector(query);
    if (qv) {
      // per-symbol best chunk only, so one symbol can't crowd the list
      const seen = new Set<number>();
      for (const hit of store.knnChunks(qv, CANDIDATES, lang)) {
        if (seen.has(hit.symbolId)) continue;
        seen.add(hit.symbolId);
        vecHits.push({ symbolId: hit.symbolId, score: hit.score });
      }
      const { chunks, embedded } = store.embeddingStats();
      if (embedded < chunks) {
        note = `semantic ranking partial: ${embedded}/${chunks} chunks embedded so far`;
      }
    } else {
      vecHits = [];
      note = `keyword-only: ${embedder.statusLines()[0]!.replace(/^embeddings: /, '')}`;
    }
  }

  const fused = new Map<number, { score: number; cosine: number | null; vec: boolean; fts: boolean }>();
  ftsRows.forEach((row, rank) => {
    const entry = fused.get(row.id) ?? { score: 0, cosine: null, vec: false, fts: false };
    entry.score += 1 / (RRF_K + rank + 1);
    entry.fts = true;
    fused.set(row.id, entry);
  });
  vecHits.forEach((hit, rank) => {
    const entry = fused.get(hit.symbolId) ?? { score: 0, cosine: null, vec: false, fts: false };
    entry.score += 1 / (RRF_K + rank + 1);
    entry.cosine = Math.max(entry.cosine ?? -1, hit.score);
    entry.vec = true;
    fused.set(hit.symbolId, entry);
  });

  const bySymbol = new Map(ftsRows.map((r) => [r.id, r]));
  const hits: SemanticHit[] = [];
  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score);
  for (const [symbolId, entry] of ranked) {
    if (hits.length >= k) break;
    const symbol = bySymbol.get(symbolId) ?? ctx.store.getSymbolById(symbolId);
    if (!symbol) continue;
    hits.push({
      symbol,
      score: entry.score,
      cosine: entry.cosine,
      sources: entry.vec && entry.fts ? 'vec+fts' : entry.vec ? 'vec' : 'fts',
    });
  }
  return { hits, note };
}
