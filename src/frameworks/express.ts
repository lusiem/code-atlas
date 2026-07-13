import type { Node } from 'web-tree-sitter';
import { parse } from '../parsing/loader.js';
import type { ExtractedRoute, FrameworkId, LanguageId } from '../types.js';

/**
 * Express/Fastify route extraction: `recv.verb('/path', ...handlers)` call
 * patterns. Receiver identity is not traced to an `express()`/`Router()` call —
 * the file-level framework import plus a string-literal path starting with
 * `/` or `*` is the false-positive guard (a `Map#get(key, x)` never matches).
 */

const VERBS: ReadonlySet<string> = new Set([
  'get', 'post', 'put', 'delete', 'patch', 'options', 'head',
]);

function stringText(node: Node): string | null {
  if (node.type !== 'string' && node.type !== 'template_string') return null;
  return node.text.replace(/^['"`]|['"`]$/g, '');
}

export async function extractExpressLike(
  framework: FrameworkId,
  lang: LanguageId,
  source: string,
): Promise<ExtractedRoute[]> {
  const tree = await parse(lang, source);
  try {
    const routes: ExtractedRoute[] = [];
    const visit = (node: Node): void => {
      if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function');
        if (fn?.type === 'member_expression') {
          const prop = fn.childForFieldName('property');
          const verb = prop?.text ?? '';
          if (VERBS.has(verb) || verb === 'all' || verb === 'use') {
            const args = node.childForFieldName('arguments');
            const positional = args?.namedChildren.filter((c) => c !== null) ?? [];
            const path = positional[0] ? stringText(positional[0]) : null;
            if (path !== null && (path.startsWith('/') || path.startsWith('*'))) {
              const last = positional[positional.length - 1];
              let handlerName: string | null = null;
              if (last && last !== positional[0]) {
                if (last.type === 'identifier') handlerName = last.text;
                else if (last.type === 'member_expression') handlerName = last.text;
              }
              const isMount = verb === 'use';
              routes.push({
                framework,
                method: isMount ? 'USE' : verb === 'all' ? 'ANY' : verb.toUpperCase(),
                path,
                fullPath: null, // cross-file mount graph is out of scope
                startLine: node.startPosition.row + 1,
                handlerLine: null,
                handlerName,
                detail: isMount && handlerName ? JSON.stringify({ mounts: handlerName }) : null,
              });
            }
          }
        }
      }
      for (const child of node.namedChildren) if (child) visit(child);
    };
    visit(tree.rootNode);
    return routes;
  } finally {
    tree.delete();
  }
}
