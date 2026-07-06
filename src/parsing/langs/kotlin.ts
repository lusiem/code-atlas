import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import { cleanComment, COMMENT_TYPES } from '../extractor.js';
import type { ExtractedImport, SymbolBase, SymbolKind } from '../../types.js';

/**
 * The kotlin grammar (fwcd/tree-sitter-kotlin) defines no field names, so all
 * patterns are positional. Anonymous keyword tokens ("interface") disambiguate
 * declaration flavors that share the class_declaration node type.
 */
const KT_QUERY = `
  (class_declaration "interface" (type_identifier) @name) @def.interface
  (class_declaration (type_identifier) @name (enum_class_body)) @def.enum
  (class_declaration (type_identifier) @name) @def.class
  (object_declaration (type_identifier) @name) @def.class
  (enum_entry (simple_identifier) @name) @def.enum_member
  (function_declaration (simple_identifier) @name) @def.function
  (source_file (property_declaration (variable_declaration (simple_identifier) @name)) @def.variable)
  (class_body (property_declaration (variable_declaration (simple_identifier) @name)) @def.field)
  (class_parameter (simple_identifier) @name) @def.property
  (type_alias (type_identifier) @name) @def.type_alias
`;

const KT_OCCURRENCES = `
  (call_expression (simple_identifier) @call)
  (call_expression (navigation_expression (navigation_suffix (simple_identifier) @call)))
  (assignment (directly_assignable_expression (simple_identifier) @write))
  (simple_identifier) @ref
  (type_identifier) @ref
`;

/** Kotlin is public by default; private/internal/protected hide a symbol. */
function isExported(defNode: Node): boolean {
  const modifiers = defNode.namedChildren.find((c) => c?.type === 'modifiers');
  if (!modifiers) return true;
  return !/\b(private|internal|protected)\b/.test(modifiers.text);
}

function reclassify(kind: SymbolKind, _name: string, parentKind: SymbolKind | null): SymbolKind {
  if (kind === 'function' && (parentKind === 'class' || parentKind === 'interface' || parentKind === 'enum')) {
    return 'method';
  }
  return kind;
}

/**
 * delegation_specifier with a constructor invocation (`: Base()`) is a
 * superclass; a bare user type (`: Drawable`) is an interface.
 */
function bases(defNode: Node): SymbolBase[] {
  if (defNode.type !== 'class_declaration' && defNode.type !== 'object_declaration') return [];
  const out: SymbolBase[] = [];
  for (const child of defNode.namedChildren) {
    if (child?.type !== 'delegation_specifier') continue;
    const ctor = child.namedChildren.find((c) => c?.type === 'constructor_invocation');
    const target = ctor ?? child;
    const userType = findFirst(target, 'user_type');
    const nameNode = userType ? findFirst(userType, 'type_identifier') : null;
    if (nameNode) {
      out.push({ name: nameNode.text, kind: ctor ? 'extends' : 'implements' });
    }
  }
  return out;
}

function findFirst(node: Node, type: string): Node | null {
  if (node.type === type) return node;
  for (const child of node.namedChildren) {
    if (!child) continue;
    const hit = findFirst(child, type);
    if (hit) return hit;
  }
  return null;
}

/**
 * KDoc lookup. Quirk: this grammar hangs a comment that precedes the first
 * declaration off the import_list, so also check the previous sibling's last
 * child.
 */
function docComment(defNode: Node, _source: string): string | null {
  let prev = defNode.previousNamedSibling;
  // descend the trailing-child chain (comment may hang off the last import_header)
  while (prev && !COMMENT_TYPES.has(prev.type) && prev.lastNamedChild) {
    prev = prev.lastNamedChild;
  }
  if (!prev || !COMMENT_TYPES.has(prev.type)) return null;
  if (prev.endPosition.row < defNode.startPosition.row - 1) return null;
  return cleanComment(prev.text);
}

function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const importList = tree.rootNode.namedChildren.find((c) => c?.type === 'import_list');
  for (const header of importList?.namedChildren ?? []) {
    if (header?.type !== 'import_header') continue;
    const id = header.namedChildren.find((c) => c?.type === 'identifier');
    if (!id) continue;
    const wildcard = header.namedChildren.some((c) => c?.type === 'wildcard_import');
    const specifier = id.text;
    imports.push({
      specifier: wildcard ? `${specifier}.*` : specifier,
      names: [wildcard ? '*' : (specifier.split('.').pop() ?? specifier)],
      startLine: header.startPosition.row + 1,
    });
  }
  return imports;
}

export const kotlinExtractor: LanguageExtractor = {
  id: 'kotlin',
  symbolQuery: KT_QUERY,
  occurrenceQuery: KT_OCCURRENCES,
  extractImports,
  isExported,
  reclassify,
  docComment,
  bases,
};
