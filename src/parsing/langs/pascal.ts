import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, SymbolBase, SymbolKind } from '../../types.js';

/**
 * Delphi/Free Pascal. Implementation-section names are qualified
 * (`function TFoo.Bar`) — the trailing identifier binds, so declaration and
 * implementation unify by name (the cpp `Shape::area` approach). Pascal is
 * case-insensitive but occurrence resolution is case-sensitive — mixed-case
 * codebases lose some cross-references. Documented limitation.
 */
const PASCAL_QUERY = `
  (unit (moduleName) @name) @def.module
  (declType (identifier) @name (declClass (kClass))) @def.class
  (declType (identifier) @name (declClass (kRecord))) @def.struct
  (declType (identifier) @name (declClass (kInterface))) @def.interface
  (declType (identifier) @name (type (declEnum))) @def.enum
  (declEnumValue (identifier) @name) @def.enum_member
  (declType (identifier) @name) @def.type_alias
  (declProc (kConstructor) (genericDot (identifier) (identifier) @name)) @def.constructor
  (declProc (kConstructor) (identifier) @name) @def.constructor
  (declProc (kDestructor) (genericDot (identifier) (identifier) @name)) @def.method
  (declProc (kDestructor) (identifier) @name) @def.method
  (declProc (genericDot (identifier) (identifier) @name)) @def.method
  (declProc (identifier) @name) @def.function
  (declField (identifier) @name) @def.field
  (declProp (kProperty) . (identifier) @name) @def.property
  (declConst (identifier) @name) @def.constant
  (declVar (identifier) @name) @def.variable
`;

const PASCAL_OCCURRENCES = `
  (exprCall (identifier) @call)
  (exprCall (exprDot (identifier) (identifier) @call))
  (assignment . (identifier) @write)
  (identifier) @ref
`;

function isExported(defNode: Node): boolean {
  for (let n: Node | null = defNode; n; n = n.parent) {
    if (n.type === 'declSection') {
      for (const child of n.namedChildren) {
        if (child?.type === 'kPrivate' || child?.type === 'kStrictPrivate') return false;
      }
      return true;
    }
    if (n.type === 'root') break;
  }
  return true;
}

/** `class(TBase, IFirst, ISecond)` — superclass first, interfaces after. */
function bases(defNode: Node): SymbolBase[] {
  const out: SymbolBase[] = [];
  const cls = defNode.namedChildren.find((c) => c?.type === 'declClass');
  if (!cls) return out;
  let first = true;
  for (const t of cls.namedChildren) {
    if (t?.type !== 'typeref') continue;
    out.push({ name: t.text, kind: first ? 'extends' : 'implements' });
    first = false;
  }
  return out;
}

function reclassify(kind: SymbolKind, _name: string, parentKind: SymbolKind | null): SymbolKind {
  if (kind === 'function' && (parentKind === 'class' || parentKind === 'struct' || parentKind === 'interface')) {
    return 'method';
  }
  return kind;
}

/** `{ Braced }` and `(* starred *)` comments both occur; strip the fences. */
function docComment(defNode: Node): string | null {
  const pieces: string[] = [];
  let prev = defNode.previousNamedSibling;
  let expectedEndRow = defNode.startPosition.row - 1;
  while (prev && prev.type === 'comment') {
    if (prev.endPosition.row < expectedEndRow) break;
    pieces.unshift(prev.text);
    expectedEndRow = prev.startPosition.row - 1;
    prev = prev.previousNamedSibling;
  }
  if (pieces.length === 0) return null;
  const cleaned = pieces
    .join('\n')
    .replace(/^\{\s?|\s?\}$/g, '')
    .replace(/^\(\*\s?|\s?\*\)$/g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/\s?/, '').trimEnd())
    .join('\n')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** `uses A, B.C;` — each unit name is one import. */
function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  for (const uses of tree.rootNode.descendantsOfType('declUses')) {
    if (!uses) continue;
    for (const mod of uses.namedChildren) {
      if (mod?.type !== 'moduleName') continue;
      imports.push({ specifier: mod.text, names: [], startLine: mod.startPosition.row + 1 });
    }
  }
  return imports;
}

export const pascalExtractor: LanguageExtractor = {
  id: 'pascal',
  symbolQuery: PASCAL_QUERY,
  occurrenceQuery: PASCAL_OCCURRENCES,
  extractImports,
  isExported,
  reclassify,
  docComment,
  bases,
};
