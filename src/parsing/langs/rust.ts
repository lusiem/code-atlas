import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, SymbolBase, SymbolKind } from '../../types.js';

const RUST_QUERY = `
  (function_item name: (identifier) @name) @def.function
  (function_signature_item name: (identifier) @name) @def.function
  (struct_item name: (type_identifier) @name) @def.struct
  (union_item name: (type_identifier) @name) @def.struct
  (enum_item name: (type_identifier) @name) @def.enum
  (enum_variant name: (identifier) @name) @def.enum_member
  (trait_item name: (type_identifier) @name) @def.trait
  (impl_item type: (type_identifier) @name) @def.impl
  (impl_item type: (generic_type type: (type_identifier) @name)) @def.impl
  (mod_item name: (identifier) @name) @def.module
  (const_item name: (identifier) @name) @def.constant
  (static_item name: (identifier) @name) @def.variable
  (type_item name: (type_identifier) @name) @def.type_alias
  (macro_definition name: (identifier) @name) @def.macro
  (field_declaration name: (field_identifier) @name) @def.field
`;

const RUST_OCCURRENCES = `
  (call_expression function: (identifier) @call)
  (call_expression function: (scoped_identifier name: (identifier) @call))
  (call_expression function: (field_expression field: (field_identifier) @call))
  (macro_invocation macro: (identifier) @call)
  (assignment_expression left: (identifier) @write)
  (assignment_expression left: (field_expression field: (field_identifier) @write))
  (identifier) @ref
  (field_identifier) @ref
  (type_identifier) @ref
`;

function isExported(defNode: Node): boolean {
  // impls and their contents are reachable wherever the type is; items need `pub`
  if (defNode.type === 'impl_item') return true;
  return defNode.namedChildren.some((c) => c?.type === 'visibility_modifier');
}

function reclassify(
  kind: SymbolKind,
  name: string,
  parentKind: SymbolKind | null,
): SymbolKind {
  if (kind === 'function' && (parentKind === 'impl' || parentKind === 'trait')) {
    return name === 'new' ? 'constructor' : 'method';
  }
  return kind;
}

/** `impl Trait for Type` — the impl symbol implements the trait. */
function bases(defNode: Node): SymbolBase[] {
  if (defNode.type !== 'impl_item') return [];
  const trait = defNode.childForFieldName('trait');
  if (!trait) return [];
  const lt = trait.text.indexOf('<');
  return [{ name: lt === -1 ? trait.text : trait.text.slice(0, lt), kind: 'implements' }];
}

function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];

  const leafNames = (node: Node, names: string[]): void => {
    switch (node.type) {
      case 'identifier':
        names.push(node.text);
        break;
      case 'use_as_clause': {
        const alias = node.childForFieldName('alias');
        if (alias) names.push(alias.text);
        break;
      }
      case 'scoped_identifier': {
        const name = node.childForFieldName('name');
        if (name) names.push(name.text);
        break;
      }
      case 'use_wildcard':
        names.push('*');
        break;
      case 'use_list':
        for (const child of node.namedChildren) if (child) leafNames(child, names);
        break;
      case 'scoped_use_list': {
        // only the braces list binds names; the path prefix does not
        const list = node.childForFieldName('list');
        if (list) leafNames(list, names);
        break;
      }
      default:
        break;
    }
  };

  const visit = (node: Node): void => {
    if (node.type === 'use_declaration') {
      const arg = node.childForFieldName('argument');
      if (arg) {
        const names: string[] = [];
        leafNames(arg, names);
        // specifier = the path prefix (for scoped_use_list) or the whole path
        const path =
          arg.type === 'scoped_use_list' ? (arg.childForFieldName('path')?.text ?? arg.text) : arg.text;
        imports.push({ specifier: path, names, startLine: node.startPosition.row + 1 });
      }
      return;
    }
    if (node.type === 'mod_item' && !node.childForFieldName('body')) {
      // `mod foo;` pulls in foo.rs / foo/mod.rs next to this file
      const name = node.childForFieldName('name');
      if (name) {
        imports.push({ specifier: `./${name.text}`, names: [name.text], startLine: node.startPosition.row + 1 });
      }
      return;
    }
    for (const child of node.namedChildren) {
      if (child && (child.type === 'use_declaration' || child.type === 'mod_item' || child.namedChildCount > 0)) {
        visit(child);
      }
    }
  };
  visit(tree.rootNode);
  return imports;
}

export const rustExtractor: LanguageExtractor = {
  id: 'rust',
  symbolQuery: RUST_QUERY,
  occurrenceQuery: RUST_OCCURRENCES,
  extractImports,
  isExported,
  reclassify,
  bases,
};
