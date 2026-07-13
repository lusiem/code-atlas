import type { ExtractedImport, FrameworkId, LanguageId } from '../types.js';

const ECMA: ReadonlySet<LanguageId> = new Set(['typescript', 'tsx', 'javascript']);

/**
 * Decide whether a code file belongs to a known web framework, from its
 * already-extracted imports (free — no extra parse). NestJS wins over the
 * express/fastify adapters it wraps; a `urls.py` basename is enough for
 * Django, whose URLconf files sometimes import nothing django-shaped.
 */
export function frameworkForFile(
  lang: LanguageId,
  path: string,
  imports: ExtractedImport[],
): FrameworkId | null {
  if (ECMA.has(lang)) {
    let express = false;
    let fastify = false;
    for (const imp of imports) {
      const s = imp.specifier;
      if (s.startsWith('@nestjs/')) return 'nestjs';
      if (s === 'express' || s.startsWith('express/')) express = true;
      else if (s === 'fastify' || s.startsWith('fastify/')) fastify = true;
    }
    if (express) return 'express';
    if (fastify) return 'fastify';
    return null;
  }
  if (lang === 'python') {
    let flask = false;
    let django = false;
    for (const imp of imports) {
      const s = imp.specifier;
      if (s === 'fastapi' || s.startsWith('fastapi.')) return 'fastapi';
      if (s === 'flask' || s.startsWith('flask.')) flask = true;
      else if (s.startsWith('django.urls') || s.startsWith('django.conf.urls')) django = true;
    }
    if (flask) return 'flask';
    if (django) return 'django';
    if (path.endsWith('/urls.py') || path === 'urls.py') return 'django';
  }
  return null;
}
