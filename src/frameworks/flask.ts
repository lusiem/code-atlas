import type { Node } from 'web-tree-sitter';
import { parse } from '../parsing/loader.js';
import type { ExtractedRoute } from '../types.js';
import { joinRoutePaths, pyFirstStringArg, pyConstructorAssignments, pyKwargString, pyStringText } from './util.js';

/**
 * Flask: classic `@app.route('/x', methods=[...])` plus the 2.x verb
 * shortcuts (`@app.get`). Blueprint `url_prefix` feeds full_path; blueprint
 * registration prefixes are cross-file and left unresolved.
 */

const SHORTCUT_VERBS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'delete', 'patch']);

const CTORS: ReadonlySet<string> = new Set(['Flask', 'Blueprint']);

/** `methods=['GET', 'POST']` -> ['GET', 'POST']; null when absent. */
function methodsKwarg(argList: Node | null): string[] | null {
  if (!argList) return null;
  for (const arg of argList.namedChildren) {
    if (arg?.type !== 'keyword_argument') continue;
    if (arg.childForFieldName('name')?.text !== 'methods') continue;
    const value = arg.childForFieldName('value');
    if (value?.type !== 'list') return null;
    const out: string[] = [];
    for (const item of value.namedChildren) {
      const s = item ? pyStringText(item) : null;
      if (s) out.push(s.toUpperCase());
    }
    return out.length > 0 ? out : null;
  }
  return null;
}

export async function extractFlaskRoutes(source: string): Promise<ExtractedRoute[]> {
  const tree = await parse('python', source);
  try {
    const prefixes = new Map<string, string>();
    for (const [name, { ctor, argList }] of pyConstructorAssignments(tree.rootNode, CTORS)) {
      prefixes.set(name, ctor === 'Blueprint' ? (pyKwargString(argList, 'url_prefix') ?? '') : '');
    }
    const routes: ExtractedRoute[] = [];
    const visit = (node: Node): void => {
      if (node.type === 'decorated_definition') {
        const def = node.childForFieldName('definition');
        const defName = def?.childForFieldName('name');
        for (const dec of node.namedChildren) {
          if (dec?.type !== 'decorator') continue;
          const call = dec.namedChildren[0];
          if (call?.type !== 'call') continue;
          const fn = call.childForFieldName('function');
          if (fn?.type !== 'attribute') continue;
          const recv = fn.childForFieldName('object');
          const attr = fn.childForFieldName('attribute')?.text ?? '';
          if (recv?.type !== 'identifier') continue;
          const isRoute = attr === 'route';
          if (!isRoute && !SHORTCUT_VERBS.has(attr)) continue;
          const argList = call.childForFieldName('arguments');
          const path = pyFirstStringArg(argList);
          if (path === null) continue;
          const prefix = prefixes.get(recv.text);
          const methods = isRoute ? (methodsKwarg(argList) ?? ['GET']) : [attr.toUpperCase()];
          for (const method of methods) {
            routes.push({
              framework: 'flask',
              method,
              path,
              fullPath: prefix !== undefined ? joinRoutePaths(prefix, path) : null,
              startLine: dec.startPosition.row + 1,
              handlerLine: defName ? defName.startPosition.row + 1 : null,
              handlerName: defName?.text ?? null,
              detail: null,
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
