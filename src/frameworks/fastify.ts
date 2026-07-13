import { extractExpressLike } from './express.js';
import type { ExtractedRoute, LanguageId } from '../types.js';

/** Fastify shares Express's `recv.verb('/path', handler)` shape. */
export function extractFastifyRoutes(lang: LanguageId, source: string): Promise<ExtractedRoute[]> {
  return extractExpressLike('fastify', lang, source);
}
