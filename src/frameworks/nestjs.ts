import type { Node } from 'web-tree-sitter';
import { parse } from '../parsing/loader.js';
import type { ExtractedRoute, LanguageId } from '../types.js';
import { joinRoutePaths } from './util.js';

/**
 * NestJS: `@Controller('users')` class prefix + `@Get(':id')` method
 * decorators. Decorators are walked from the tree (node shapes differ between
 * typescript/tsx grammar versions less than query patterns do).
 */

const METHOD_DECORATORS: ReadonlyMap<string, string> = new Map([
  ['Get', 'GET'], ['Post', 'POST'], ['Put', 'PUT'], ['Delete', 'DELETE'],
  ['Patch', 'PATCH'], ['Options', 'OPTIONS'], ['Head', 'HEAD'], ['All', 'ANY'],
]);

/** Decorator name + first string argument (or null), from a (decorator) node. */
function readDecorator(dec: Node): { name: string; arg: string | null } | null {
  const inner = dec.namedChildren[0];
  if (!inner) return null;
  if (inner.type === 'identifier') return { name: inner.text, arg: null };
  if (inner.type === 'call_expression') {
    const fn = inner.childForFieldName('function');
    if (fn?.type !== 'identifier') return null;
    const args = inner.childForFieldName('arguments');
    const first = args?.namedChildren.find((c) => c !== null);
    const arg =
      first && (first.type === 'string' || first.type === 'template_string')
        ? first.text.replace(/^['"`]|['"`]$/g, '')
        : null;
    return { name: fn.text, arg };
  }
  return null;
}

export async function extractNestRoutes(
  lang: LanguageId,
  source: string,
): Promise<ExtractedRoute[]> {
  const tree = await parse(lang, source);
  try {
    const routes: ExtractedRoute[] = [];
    // decorators precede their target as siblings (inside class_body, or
    // inside export_statement/program for the class itself)
    const visitClass = (cls: Node, prefix: string): void => {
      const body = cls.childForFieldName('body');
      if (!body) return;
      let pending: Node[] = [];
      for (const member of body.namedChildren) {
        if (!member) continue;
        if (member.type === 'decorator') {
          pending.push(member);
          continue;
        }
        if (member.type === 'method_definition') {
          for (const dec of pending) {
            const parsed = readDecorator(dec);
            const method = parsed && METHOD_DECORATORS.get(parsed.name);
            if (!parsed || !method) continue;
            const nameNode = member.childForFieldName('name');
            routes.push({
              framework: 'nestjs',
              method,
              path: parsed.arg ?? '',
              fullPath: joinRoutePaths(prefix, parsed.arg ?? ''),
              startLine: dec.startPosition.row + 1,
              handlerLine: nameNode ? nameNode.startPosition.row + 1 : null,
              handlerName: nameNode?.text ?? null,
              detail: null,
            });
          }
        }
        pending = [];
      }
    };
    const classDecorators = (cls: Node): Node[] => {
      const out = cls.namedChildren.filter((c): c is Node => c?.type === 'decorator');
      // walk backwards over preceding siblings (export_statement or program)
      for (let sib = cls.previousNamedSibling; sib?.type === 'decorator'; sib = sib.previousNamedSibling) {
        out.push(sib);
      }
      if (cls.parent?.type === 'export_statement') {
        out.push(...cls.parent.namedChildren.filter((c): c is Node => c?.type === 'decorator'));
      }
      return out;
    };
    const visit = (node: Node): void => {
      if (node.type === 'class_declaration' || node.type === 'abstract_class_declaration') {
        for (const dec of classDecorators(node)) {
          const parsed = readDecorator(dec);
          if (parsed?.name === 'Controller') {
            visitClass(node, parsed.arg ?? '');
            return; // methods handled; controllers don't nest
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
