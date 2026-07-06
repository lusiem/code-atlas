import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, SymbolBase, SymbolKind } from '../../types.js';

/**
 * C++ (also used, minus C++-only node types, as the template for C).
 * Function declarators nest (`int *f()` = pointer_declarator > function_declarator),
 * so the common one-level wrappers get their own patterns.
 */
const CPP_QUERY = `
  (function_definition declarator: (function_declarator declarator: (identifier) @name)) @def.function
  (function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @def.function
  (function_definition declarator: (reference_declarator (function_declarator declarator: (identifier) @name))) @def.function
  (function_definition declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))) @def.method
  (function_definition declarator: (function_declarator declarator: (field_identifier) @name)) @def.method
  (declaration declarator: (function_declarator declarator: (identifier) @name)) @def.function
  (field_declaration declarator: (function_declarator declarator: (field_identifier) @name)) @def.method
  (class_specifier name: (type_identifier) @name body: (_)) @def.class
  (struct_specifier name: (type_identifier) @name body: (_)) @def.struct
  (union_specifier name: (type_identifier) @name body: (_)) @def.struct
  (enum_specifier name: (type_identifier) @name body: (_)) @def.enum
  (enumerator name: (identifier) @name) @def.enum_member
  (namespace_definition name: (namespace_identifier) @name) @def.namespace
  (field_declaration declarator: (field_identifier) @name) @def.field
  (field_declaration declarator: (pointer_declarator declarator: (field_identifier) @name)) @def.field
  (type_definition declarator: (type_identifier) @name) @def.type_alias
  (alias_declaration name: (type_identifier) @name) @def.type_alias
  (preproc_def name: (identifier) @name) @def.macro
  (preproc_function_def name: (identifier) @name) @def.macro
  (translation_unit (declaration declarator: (init_declarator declarator: (identifier) @name)) @def.variable)
  (namespace_definition body: (declaration_list (declaration declarator: (init_declarator declarator: (identifier) @name) @def.variable)))
`;

const CPP_OCCURRENCES = `
  (call_expression function: (identifier) @call)
  (call_expression function: (field_expression field: (field_identifier) @call))
  (call_expression function: (qualified_identifier name: (identifier) @call))
  (assignment_expression left: (identifier) @write)
  (assignment_expression left: (field_expression field: (field_identifier) @write))
  (identifier) @ref
  (field_identifier) @ref
  (type_identifier) @ref
  (namespace_identifier) @ref
`;

/**
 * Constructors parse as functions named like their class; out-of-class
 * qualified definitions arrive as methods already.
 */
function reclassify(
  kind: SymbolKind,
  name: string,
  parentKind: SymbolKind | null,
  parentName: string | null,
): SymbolKind {
  if (parentKind === 'class' || parentKind === 'struct') {
    if (name === parentName) return 'constructor';
    if (kind === 'function') return 'method';
  }
  return kind;
}

/** Bases from `class D : public B1, private B2`. */
function bases(defNode: Node): SymbolBase[] {
  if (defNode.type !== 'class_specifier' && defNode.type !== 'struct_specifier') return [];
  const out: SymbolBase[] = [];
  for (const child of defNode.namedChildren) {
    if (child?.type !== 'base_class_clause') continue;
    for (const base of child.namedChildren) {
      if (
        base?.type === 'type_identifier' ||
        base?.type === 'qualified_identifier' ||
        base?.type === 'template_type'
      ) {
        const lt = base.text.indexOf('<');
        out.push({ name: lt === -1 ? base.text : base.text.slice(0, lt), kind: 'extends' });
      }
    }
  }
  return out;
}

/** Shared by the C extractor. */
export function extractIncludeImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  for (const node of tree.rootNode.namedChildren) {
    if (node?.type !== 'preproc_include') continue;
    const path = node.childForFieldName('path');
    if (!path) continue;
    // "local.h" (resolvable) vs <system> (external); keep the delimiter info
    const specifier =
      path.type === 'system_lib_string'
        ? path.text // keep <...> so the resolver knows it is a system include
        : path.text.replace(/^"|"$/g, '');
    imports.push({ specifier, names: [], startLine: node.startPosition.row + 1 });
  }
  return imports;
}

export const cppExtractor: LanguageExtractor = {
  id: 'cpp',
  symbolQuery: CPP_QUERY,
  occurrenceQuery: CPP_OCCURRENCES,
  extractImports: extractIncludeImports,
  // structural layer cannot see access specifiers cheaply; headers are the
  // public surface in C++, so default everything to exported
  isExported: () => true,
  reclassify,
  bases,
};
