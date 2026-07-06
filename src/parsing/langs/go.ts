import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, SymbolBase } from '../../types.js';

/** Pattern order matters: struct/interface type_specs before the alias fallback. */
const GO_QUERY = `
  (type_spec name: (type_identifier) @name type: (struct_type)) @def.struct
  (type_spec name: (type_identifier) @name type: (interface_type)) @def.interface
  (type_spec name: (type_identifier) @name) @def.type_alias
  (function_declaration name: (identifier) @name) @def.function
  (method_declaration name: (field_identifier) @name) @def.method
  (method_elem name: (field_identifier) @name) @def.method
  (field_declaration name: (field_identifier) @name) @def.field
  (const_spec name: (identifier) @name) @def.constant
  (source_file (var_declaration (var_spec name: (identifier) @name) @def.variable))
`;

const GO_OCCURRENCES = `
  (call_expression function: (identifier) @call)
  (call_expression function: (selector_expression field: (field_identifier) @call))
  (assignment_statement left: (expression_list (identifier) @write))
  (identifier) @ref
  (field_identifier) @ref
  (type_identifier) @ref
  (package_identifier) @ref
`;

/** Go exports by capitalization. */
function isExported(_defNode: Node, nameText: string): boolean {
  return /^[A-Z]/.test(nameText);
}

/** Embedded struct fields (`type A struct { B }`) behave like inheritance. */
function bases(defNode: Node): SymbolBase[] {
  if (defNode.type !== 'type_spec') return [];
  const type = defNode.childForFieldName('type');
  if (type?.type !== 'struct_type') return [];
  const out: SymbolBase[] = [];
  const fieldList = type.namedChildren.find((c) => c?.type === 'field_declaration_list');
  for (const field of fieldList?.namedChildren ?? []) {
    if (field?.type !== 'field_declaration') continue;
    if (field.childForFieldName('name')) continue; // named field, not embedded
    const embedded = field.childForFieldName('type');
    if (!embedded) continue;
    const text = embedded.text.replace(/^\*/, '');
    const name = text.split('.').pop();
    if (name) out.push({ name, kind: 'extends' });
  }
  return out;
}

function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const addSpec = (spec: Node): void => {
    const path = spec.childForFieldName('path');
    if (!path) return;
    const specifier = path.text.replace(/^"|"$/g, '');
    const alias = spec.childForFieldName('name')?.text;
    const lastSegment = specifier.split('/').pop() ?? specifier;
    imports.push({
      specifier,
      names: [alias ?? lastSegment],
      startLine: spec.startPosition.row + 1,
    });
  };
  for (const node of tree.rootNode.namedChildren) {
    if (node?.type !== 'import_declaration') continue;
    for (const child of node.namedChildren) {
      if (child?.type === 'import_spec') addSpec(child);
      else if (child?.type === 'import_spec_list') {
        for (const spec of child.namedChildren) {
          if (spec?.type === 'import_spec') addSpec(spec);
        }
      }
    }
  }
  return imports;
}

export const goExtractor: LanguageExtractor = {
  id: 'go',
  symbolQuery: GO_QUERY,
  occurrenceQuery: GO_OCCURRENCES,
  extractImports,
  isExported,
  bases,
};
