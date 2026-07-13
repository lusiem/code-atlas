import type { Node } from 'web-tree-sitter';
import { parse } from '../parsing/loader.js';
import type { ExtractedRoute } from '../types.js';
import { joinRoutePaths, pyFirstStringArg, pyConstructorAssignments, pyKwargString } from './util.js';

/**
 * FastAPI: `@app.get("/x")` / `@router.post("/y")` decorators on functions.
 * `APIRouter(prefix="/p")` assignments in the same file feed full_path;
 * `include_router` mounting is cross-file and deliberately left unresolved.
 */

const VERBS: ReadonlySet<string> = new Set([
  'get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'websocket',
]);

const CTORS: ReadonlySet<string> = new Set(['FastAPI', 'APIRouter']);

export async function extractFastapiRoutes(source: string): Promise<ExtractedRoute[]> {
  const tree = await parse('python', source);
  try {
    const prefixes = new Map<string, string>();
    for (const [name, { argList }] of pyConstructorAssignments(tree.rootNode, CTORS)) {
      prefixes.set(name, pyKwargString(argList, 'prefix') ?? '');
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
          const verb = fn.childForFieldName('attribute')?.text ?? '';
          if (!VERBS.has(verb) || recv?.type !== 'identifier') continue;
          const path = pyFirstStringArg(call.childForFieldName('arguments'));
          if (path === null) continue;
          const prefix = prefixes.get(recv.text);
          routes.push({
            framework: 'fastapi',
            method: verb === 'websocket' ? 'WS' : verb.toUpperCase(),
            path,
            fullPath: prefix !== undefined ? joinRoutePaths(prefix, path) : null,
            startLine: dec.startPosition.row + 1,
            handlerLine: defName ? defName.startPosition.row + 1 : null,
            handlerName: defName?.text ?? null,
            detail: null,
          });
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
