import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, SymbolBase } from '../../types.js';

const JAVA_QUERY = `
  (class_declaration name: (identifier) @name) @def.class
  (interface_declaration name: (identifier) @name) @def.interface
  (enum_declaration name: (identifier) @name) @def.enum
  (enum_constant name: (identifier) @name) @def.enum_member
  (record_declaration name: (identifier) @name) @def.class
  (annotation_type_declaration name: (identifier) @name) @def.interface
  (method_declaration name: (identifier) @name) @def.method
  (constructor_declaration name: (identifier) @name) @def.constructor
  (field_declaration declarator: (variable_declarator name: (identifier) @name)) @def.field
`;

const JAVA_OCCURRENCES = `
  (method_invocation name: (identifier) @call)
  (object_creation_expression type: (type_identifier) @call)
  (assignment_expression left: (identifier) @write)
  (assignment_expression left: (field_access field: (identifier) @write))
  (identifier) @ref
  (type_identifier) @ref
`;

function isExported(defNode: Node): boolean {
  const modifiers = defNode.namedChildren.find((c) => c?.type === 'modifiers');
  if (modifiers) return /\bpublic\b/.test(modifiers.text);
  // no modifiers: package-private, except interface/annotation members which
  // are implicitly public — close enough for a structural index
  const p = defNode.parent;
  return p?.type === 'interface_body' || p?.type === 'annotation_type_body';
}

function collectTypeNames(node: Node, kind: 'extends' | 'implements', out: SymbolBase[]): void {
  if (node.type === 'type_identifier') {
    out.push({ name: node.text, kind });
    return;
  }
  if (node.type === 'generic_type' || node.type === 'scoped_type_identifier' || node.type === 'type_list') {
    for (const child of node.namedChildren) {
      if (child?.type === 'type_identifier') out.push({ name: child.text, kind });
      else if (child?.type === 'generic_type') {
        const first = child.namedChildren[0];
        if (first?.type === 'type_identifier') out.push({ name: first.text, kind });
      }
    }
  }
}

function bases(defNode: Node): SymbolBase[] {
  const out: SymbolBase[] = [];
  for (const child of defNode.namedChildren) {
    if (!child) continue;
    if (child.type === 'superclass') {
      for (const t of child.namedChildren) if (t) collectTypeNames(t, 'extends', out);
    } else if (child.type === 'super_interfaces') {
      for (const t of child.namedChildren) if (t) collectTypeNames(t, 'implements', out);
    } else if (child.type === 'extends_interfaces') {
      for (const t of child.namedChildren) if (t) collectTypeNames(t, 'extends', out);
    }
  }
  return out;
}

function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  for (const node of tree.rootNode.namedChildren) {
    if (node?.type !== 'import_declaration') continue;
    const scoped = node.namedChildren.find(
      (c) => c?.type === 'scoped_identifier' || c?.type === 'identifier',
    );
    if (!scoped) continue;
    const wildcard = node.namedChildren.some((c) => c?.type === 'asterisk');
    const specifier = scoped.text;
    imports.push({
      specifier: wildcard ? `${specifier}.*` : specifier,
      names: [wildcard ? '*' : (specifier.split('.').pop() ?? specifier)],
      startLine: node.startPosition.row + 1,
    });
  }
  return imports;
}

export const javaExtractor: LanguageExtractor = {
  id: 'java',
  symbolQuery: JAVA_QUERY,
  occurrenceQuery: JAVA_OCCURRENCES,
  extractImports,
  isExported,
  bases,
};
