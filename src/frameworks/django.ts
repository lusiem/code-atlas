import type { Node } from 'web-tree-sitter';
import { parse } from '../parsing/loader.js';
import type { ExtractedRoute } from '../types.js';
import { pyFirstStringArg, pyStringText } from './util.js';

/**
 * Django URLconf: `path('users/<int:pk>/', views.detail)` / `re_path` / `url`
 * calls. Handlers are dotted names resolved later by the resolver; the HTTP
 * method is not part of the URLconf, so every route is ANY. urlpatterns built
 * dynamically (loops, `+=` of computed lists) are invisible — documented gap.
 */

const ROUTE_FNS: ReadonlySet<string> = new Set(['path', 're_path', 'url']);

/** Second-argument handler: `views.detail`, `Detail.as_view()`, bare name, or include(). */
function readHandler(arg: Node): { name: string | null; detail: string | null } {
  if (arg.type === 'attribute' || arg.type === 'identifier') {
    return { name: arg.text, detail: null };
  }
  if (arg.type === 'call') {
    const fn = arg.childForFieldName('function');
    if (fn?.type === 'attribute' && fn.childForFieldName('attribute')?.text === 'as_view') {
      return { name: fn.childForFieldName('object')?.text ?? null, detail: null };
    }
    if (fn?.type === 'identifier' && fn.text === 'include') {
      const target = pyFirstStringArg(arg.childForFieldName('arguments'));
      return { name: null, detail: JSON.stringify({ include: target ?? '?' }) };
    }
  }
  return { name: null, detail: null };
}

export async function extractDjangoRoutes(source: string): Promise<ExtractedRoute[]> {
  const tree = await parse('python', source);
  try {
    const routes: ExtractedRoute[] = [];
    const visit = (node: Node): void => {
      if (node.type === 'call') {
        const fn = node.childForFieldName('function');
        if (fn?.type === 'identifier' && ROUTE_FNS.has(fn.text)) {
          const args = node.childForFieldName('arguments');
          const positional = args?.namedChildren.filter((c) => c !== null && c.type !== 'keyword_argument') ?? [];
          const path = positional[0] ? pyStringText(positional[0]) : null;
          if (path !== null && positional[1]) {
            const handler = readHandler(positional[1]);
            routes.push({
              framework: 'django',
              method: 'ANY',
              path,
              fullPath: null, // include() nesting is cross-file
              startLine: node.startPosition.row + 1,
              handlerLine: null,
              handlerName: handler.name,
              detail: handler.detail,
            });
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
