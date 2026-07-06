import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, SymbolBase } from '../../types.js';

const CS_QUERY = `
  (class_declaration name: (identifier) @name) @def.class
  (interface_declaration name: (identifier) @name) @def.interface
  (struct_declaration name: (identifier) @name) @def.struct
  (enum_declaration name: (identifier) @name) @def.enum
  (enum_member_declaration name: (identifier) @name) @def.enum_member
  (record_declaration name: (identifier) @name) @def.class
  (method_declaration name: (identifier) @name) @def.method
  (constructor_declaration name: (identifier) @name) @def.constructor
  (local_function_statement name: (identifier) @name) @def.function
  (property_declaration name: (identifier) @name) @def.property
  (field_declaration (variable_declaration (variable_declarator name: (identifier) @name))) @def.field
  (event_field_declaration (variable_declaration (variable_declarator name: (identifier) @name))) @def.field
  (delegate_declaration name: (identifier) @name) @def.type_alias
  (namespace_declaration name: (_) @name) @def.namespace
  (file_scoped_namespace_declaration name: (_) @name) @def.namespace
`;

const CS_OCCURRENCES = `
  (invocation_expression function: (identifier) @call)
  (invocation_expression function: (member_access_expression name: (identifier) @call))
  (object_creation_expression type: (identifier) @call)
  (object_creation_expression type: (generic_name (identifier) @call))
  (assignment_expression left: (identifier) @write)
  (assignment_expression left: (member_access_expression name: (identifier) @write))
  (identifier) @ref
`;

function isExported(defNode: Node): boolean {
  if (
    defNode.type === 'namespace_declaration' ||
    defNode.type === 'file_scoped_namespace_declaration'
  ) {
    return true;
  }
  if (defNode.parent?.type === 'declaration_list' && defNode.parent.parent?.type === 'interface_declaration') {
    return true; // interface members are implicitly public
  }
  return defNode.namedChildren.some((c) => c?.type === 'modifier' && c.text === 'public');
}

/**
 * `class D : Base, IThing` — C# syntax does not distinguish base class from
 * interfaces, so everything is recorded as extends.
 */
function bases(defNode: Node): SymbolBase[] {
  const out: SymbolBase[] = [];
  for (const child of defNode.namedChildren) {
    if (child?.type !== 'base_list') continue;
    for (const base of child.namedChildren) {
      if (!base) continue;
      if (base.type === 'identifier' || base.type === 'qualified_name') {
        out.push({ name: base.text, kind: 'extends' });
      } else if (base.type === 'generic_name') {
        const first = base.namedChildren[0];
        if (first?.type === 'identifier') out.push({ name: first.text, kind: 'extends' });
      }
    }
  }
  return out;
}

function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'using_directive') {
      const target = node.namedChildren.find(
        (c) => c?.type === 'qualified_name' || c?.type === 'identifier',
      );
      if (target) {
        imports.push({ specifier: target.text, names: [], startLine: node.startPosition.row + 1 });
      }
      return;
    }
    // usings may sit inside (block-form) namespace declarations
    if (node.type === 'compilation_unit' || node.type === 'namespace_declaration' || node.type === 'declaration_list') {
      for (const child of node.namedChildren) if (child) visit(child);
    }
  };
  visit(tree.rootNode);
  return imports;
}

export const csharpExtractor: LanguageExtractor = {
  id: 'c_sharp',
  symbolQuery: CS_QUERY,
  occurrenceQuery: CS_OCCURRENCES,
  extractImports,
  isExported,
  bases,
};
