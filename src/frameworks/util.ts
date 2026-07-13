import type { Node } from 'web-tree-sitter';

/** `/users` + `:id` -> `/users/:id`; empty segments and stray slashes collapse. */
export function joinRoutePaths(prefix: string, path: string): string {
  const a = prefix.replace(/\/+$/, '');
  const b = path.replace(/^\/+/, '');
  const joined = b ? `${a}/${b}` : a;
  return joined.startsWith('/') ? joined : `/${joined}`;
}

/** Text of a python (string) node without quotes/prefixes, or null. */
export function pyStringText(node: Node): string | null {
  if (node.type !== 'string') return null;
  return node.namedChildren.find((c) => c?.type === 'string_content')?.text ?? null;
}

/** First positional (string) argument of a python (argument_list). */
export function pyFirstStringArg(argList: Node | null): string | null {
  if (!argList) return null;
  for (const arg of argList.namedChildren) {
    if (!arg) continue;
    if (arg.type === 'string') return pyStringText(arg);
    if (arg.type !== 'comment') break; // first positional isn't a string
  }
  return null;
}

/** Value of a `name="..."` keyword argument in a python (argument_list). */
export function pyKwargString(argList: Node | null, name: string): string | null {
  if (!argList) return null;
  for (const arg of argList.namedChildren) {
    if (arg?.type !== 'keyword_argument') continue;
    if (arg.childForFieldName('name')?.text !== name) continue;
    const value = arg.childForFieldName('value');
    return value ? pyStringText(value) : null;
  }
  return null;
}

/**
 * Module-level `var = Ctor(...)` assignments, mapping variable name to the
 * constructor call — used to learn app/router/blueprint prefixes in-file.
 */
export function pyConstructorAssignments(
  root: Node,
  ctors: ReadonlySet<string>,
): Map<string, { ctor: string; argList: Node | null }> {
  const out = new Map<string, { ctor: string; argList: Node | null }>();
  for (const stmt of root.namedChildren) {
    if (stmt?.type !== 'expression_statement') continue;
    const assign = stmt.namedChildren[0];
    if (assign?.type !== 'assignment') continue;
    const left = assign.childForFieldName('left');
    const right = assign.childForFieldName('right');
    if (left?.type !== 'identifier' || right?.type !== 'call') continue;
    const fn = right.childForFieldName('function');
    const ctor = fn?.type === 'identifier' ? fn.text : fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : undefined;
    if (!ctor || !ctors.has(ctor)) continue;
    out.set(left.text, { ctor, argList: right.childForFieldName('arguments') });
  }
  return out;
}
