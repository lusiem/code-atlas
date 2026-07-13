import type { ExtractedRoute, FrameworkId, LanguageId } from '../types.js';
import { extractExpressLike } from './express.js';
import { extractFastifyRoutes } from './fastify.js';
import { extractNestRoutes } from './nestjs.js';
import { extractFastapiRoutes } from './fastapi.js';
import { extractFlaskRoutes } from './flask.js';
import { extractDjangoRoutes } from './django.js';

/**
 * Route extraction re-parses the file via the (cached) loader rather than
 * threading the tree out of extractFile — only framework-importing files pay
 * the second parse, and the general extraction pipeline stays untouched.
 */
export function extractRoutes(
  framework: FrameworkId,
  lang: LanguageId,
  source: string,
): Promise<ExtractedRoute[]> {
  switch (framework) {
    case 'express':
      return extractExpressLike('express', lang, source);
    case 'fastify':
      return extractFastifyRoutes(lang, source);
    case 'nestjs':
      return extractNestRoutes(lang, source);
    case 'fastapi':
      return extractFastapiRoutes(source);
    case 'flask':
      return extractFlaskRoutes(source);
    case 'django':
      return extractDjangoRoutes(source);
  }
}
