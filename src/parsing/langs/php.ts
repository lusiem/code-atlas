import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, SymbolBase, SymbolKind } from '../../types.js';

/**
 * The @vscode/tree-sitter-wasm php grammar is the HTML-mixed variant: php
 * nodes live under (program (php_tag) ...). Queries target the php nodes, so
 * templates with interleaved text work unchanged.
 */

const PHP_QUERY = `
  (class_declaration name: (name) @name) @def.class
  (interface_declaration name: (name) @name) @def.interface
  (trait_declaration name: (name) @name) @def.trait
  (enum_declaration name: (name) @name) @def.enum
  (enum_case name: (name) @name) @def.enum_member
  (method_declaration name: (name) @name) @def.method
  (function_definition name: (name) @name) @def.function
  (const_element (name) @name) @def.constant
  (property_element (variable_name (name) @name)) @def.property
  (namespace_definition name: (namespace_name) @name) @def.namespace
`;

const PHP_OCCURRENCES = `
  (function_call_expression function: (name) @call)
  (member_call_expression name: (name) @call)
  (scoped_call_expression name: (name) @call)
  (nullsafe_member_call_expression name: (name) @call)
  (object_creation_expression (name) @call)
  (named_type (name) @ref)
  (name) @ref
`;

function isExported(defNode: Node): boolean {
  for (const child of defNode.namedChildren) {
    if (child?.type === 'visibility_modifier' && child.text !== 'public') return false;
  }
  return true;
}

function bases(defNode: Node): SymbolBase[] {
  const out: SymbolBase[] = [];
  for (const child of defNode.namedChildren) {
    if (child?.type === 'base_clause') {
      for (const t of child.namedChildren) {
        if (t?.type === 'name' || t?.type === 'qualified_name') {
          out.push({ name: lastName(t.text), kind: 'extends' });
        }
      }
    } else if (child?.type === 'class_interface_clause') {
      for (const t of child.namedChildren) {
        if (t?.type === 'name' || t?.type === 'qualified_name') {
          out.push({ name: lastName(t.text), kind: 'implements' });
        }
      }
    }
  }
  return out;
}

/** `App\Models\User` -> `User`. */
function lastName(qualified: string): string {
  const slash = qualified.lastIndexOf('\\');
  return slash === -1 ? qualified : qualified.slice(slash + 1);
}

function reclassify(kind: SymbolKind, name: string): SymbolKind {
  if (kind === 'method' && name === '__construct') return 'constructor';
  return kind;
}

/** `use A\B\C as D;` — specifier keeps the full path, the bound name is D (else C). */
function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'namespace_use_declaration') {
      for (const clause of node.namedChildren) {
        if (clause?.type !== 'namespace_use_clause') continue;
        const qualified = clause.namedChildren.find(
          (c) => c?.type === 'qualified_name' || c?.type === 'name',
        );
        if (!qualified) continue;
        const alias = clause.namedChildren.find((c) => c?.type === 'name' && c !== qualified);
        imports.push({
          specifier: qualified.text,
          names: [alias?.text ?? lastName(qualified.text)],
          startLine: node.startPosition.row + 1,
        });
      }
      return;
    }
    if (node.type === 'program' || node.type === 'namespace_definition' || node.type === 'declaration_list') {
      for (const child of node.namedChildren) if (child) visit(child);
    }
  };
  visit(tree.rootNode);
  return imports;
}

export const phpExtractor: LanguageExtractor = {
  id: 'php',
  symbolQuery: PHP_QUERY,
  occurrenceQuery: PHP_OCCURRENCES,
  extractImports,
  isExported,
  reclassify,
  bases,
};
