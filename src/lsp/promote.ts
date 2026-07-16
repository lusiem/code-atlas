import type { AppContext } from '../context.js';
import { relFromUri } from './overlay.js';

/**
 * Opt-in background pass (config lsp.promoteEdges) that verifies low-confidence
 * heuristic call edges against a language server: a textDocument/definition at a
 * resolved call site either confirms the edge (promote to lsp/1.0), lands on a
 * different indexed symbol (insert the correct edge, drop the wrong one — a
 * best-effort demotion; re-resolution re-inserts index edges), or answers
 * nothing (left untouched: absence of LSP evidence is not refutation).
 *
 * Budgeted by construction: never starts a server, one request in flight,
 * hard request/time caps, aborts while the indexer is busy. A (src,dst)
 * cursor in meta makes successive passes cover the whole edge set.
 */

export interface PromoteBudget {
  maxRequests: number;
  maxMs: number;
}

export interface PromoteStats {
  examined: number;
  confirmed: number;
  corrected: number;
  unverified: number;
  skippedNoClient: number;
}

const MAX_CONFIDENCE = 0.6;
const BATCH = 100;
const REQUEST_GAP_MS = 5;
const CURSOR_KEY = 'promote_cursor';

export const DEFAULT_PROMOTE_BUDGET: PromoteBudget = { maxRequests: 200, maxMs: 30_000 };

function loadCursor(raw: string | undefined): { src: number; dst: number } | undefined {
  const m = raw ? /^(\d+):(\d+)$/.exec(raw) : null;
  return m ? { src: Number(m[1]), dst: Number(m[2]) } : undefined;
}

export async function promoteEdges(
  ctx: AppContext,
  budget: PromoteBudget = DEFAULT_PROMOTE_BUDGET,
): Promise<PromoteStats> {
  const stats: PromoteStats = { examined: 0, confirmed: 0, corrected: 0, unverified: 0, skippedNoClient: 0 };
  const { store } = ctx;
  if (!ctx.lsp?.enabled) return stats;

  let cursor = loadCursor(store.getMeta(CURSOR_KEY));
  const started = Date.now();
  let requests = 0;

  const save = (): void => {
    if (cursor) store.setMeta(CURSOR_KEY, `${cursor.src}:${cursor.dst}`);
    else store.setMeta(CURSOR_KEY, '');
  };

  for (;;) {
    const batch = store.lowConfidenceCallEdges(MAX_CONFIDENCE, BATCH, cursor);
    if (batch.length === 0) {
      cursor = undefined; // wrapped: next pass starts from the beginning
      save();
      return stats;
    }
    for (const edge of batch) {
      // budget checks run before the edge is consumed; the cursor advances only
      // after processing, so a stopped pass retries this edge next time
      if (requests >= budget.maxRequests || Date.now() - started > budget.maxMs) {
        save();
        return stats;
      }
      if (ctx.indexer.progress.state === 'indexing') {
        save(); // never compete with an indexing pass
        return stats;
      }
      cursor = { src: edge.srcSymbolId, dst: edge.dstSymbolId };
      const src = store.getSymbolById(edge.srcSymbolId);
      const dst = store.getSymbolById(edge.dstSymbolId);
      if (!src || !dst) continue;
      const client = ctx.lsp.runningClientFor(src.lang);
      if (!client) {
        stats.skippedNoClient++;
        continue;
      }
      const occ = store.callOccurrenceForEdge(src.fileId, dst.id, src.startLine, src.endLine);
      if (!occ) continue;

      requests++;
      await new Promise((r) => setTimeout(r, REQUEST_GAP_MS));
      const locs = await client.definition(src.path, {
        line: occ.startLine - 1,
        character: occ.startCol,
      });
      stats.examined++;
      const loc = locs?.[0];
      const rel = loc ? relFromUri(ctx, loc.uri) : null;
      if (!loc || !rel) {
        stats.unverified++;
        continue;
      }
      const line = loc.range.start.line + 1;
      if (rel === dst.path && line >= dst.startLine && line <= dst.endLine) {
        store.insertEdges([
          { srcSymbolId: src.id, dstSymbolId: dst.id, kind: 'calls', confidence: 1.0, provenance: 'lsp' },
        ]);
        stats.confirmed++;
        continue;
      }
      const file = store.getFileByPath(rel);
      const target = file ? store.symbolAt(file.id, line, Number.MAX_SAFE_INTEGER) : undefined;
      if (target && target.id !== dst.id) {
        store.insertEdges([
          { srcSymbolId: src.id, dstSymbolId: target.id, kind: 'calls', confidence: 1.0, provenance: 'lsp' },
        ]);
        store.deleteEdge(src.id, dst.id, 'calls');
        stats.corrected++;
      } else {
        stats.unverified++;
      }
    }
  }
}
