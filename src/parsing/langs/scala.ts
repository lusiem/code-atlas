import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, SymbolBase, SymbolKind } from '../../types.js';

/**
 * Scala 2 and 3 both parse with the official grammar (braces and
 * indentation syntax alike). vals/vars are anchored to template bodies and
 * the compilation unit so method-local bindings stay out of the index.
 */
const SCALA_QUERY = `
  (class_definition name: (identifier) @name) @def.class
  (object_definition name: (identifier) @name) @def.module
  (trait_definition name: (identifier) @name) @def.trait
  (enum_definition name: (identifier) @name) @def.enum
  (simple_enum_case name: (identifier) @name) @def.enum_member
  (full_enum_case name: (identifier) @name) @def.enum_member
  (function_definition name: (identifier) @name) @def.function
  (function_declaration name: (identifier) @name) @def.function
  (type_definition name: (type_identifier) @name) @def.type_alias
  (template_body (val_definition pattern: (identifier) @name) @def.constant)
  (template_body (var_definition pattern: (identifier) @name) @def.variable)
  (compilation_unit (val_definition pattern: (identifier) @name) @def.constant)
  (compilation_unit (var_definition pattern: (identifier) @name) @def.variable)
`;

const SCALA_OCCURRENCES = `
  (call_expression function: (identifier) @call)
  (call_expression function: (field_expression field: (identifier) @call))
  (assignment_expression left: (identifier) @write)
  (identifier) @ref
  (type_identifier) @ref
`;

function isExported(defNode: Node): boolean {
  for (const child of defNode.namedChildren) {
    if (child?.type === 'modifiers') {
      for (const m of child.namedChildren) {
        if (m?.type === 'access_modifier') return false; // private/protected
      }
    }
  }
  return true;
}

/** `extends A with B with C` — first is the superclass, the rest mixins. */
function bases(defNode: Node): SymbolBase[] {
  const out: SymbolBase[] = [];
  const clause = defNode.namedChildren.find((c) => c?.type === 'extends_clause');
  if (!clause) return out;
  let first = true;
  for (const t of clause.namedChildren) {
    if (t?.type !== 'type_identifier' && t?.type !== 'generic_type') continue;
    const name = t.text.replace(/\[.*$/, '');
    out.push({ name, kind: first ? 'extends' : 'implements' });
    first = false;
  }
  return out;
}

function reclassify(kind: SymbolKind, _name: string, parentKind: SymbolKind | null): SymbolKind {
  if (
    kind === 'function' &&
    (parentKind === 'class' || parentKind === 'trait' || parentKind === 'module' || parentKind === 'enum')
  ) {
    return 'method';
  }
  return kind;
}

/** `import a.b.{C, D => E}` / `import a.b._` -> specifier a.b, names C, E. */
function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'import_declaration') {
      const path: string[] = [];
      const names: string[] = [];
      for (const child of node.namedChildren) {
        if (child?.type === 'identifier') path.push(child.text);
        else if (child?.type === 'namespace_selectors') {
          for (const sel of child.namedChildren) {
            if (sel?.type === 'identifier') names.push(sel.text);
            else if (sel?.type === 'arrow_renamed_identifier') {
              const renamed = sel.namedChildren[1] ?? sel.namedChildren[0];
              if (renamed) names.push(renamed.text);
            }
          }
        } else if (child?.type === 'namespace_wildcard') {
          names.push('*');
        }
      }
      if (path.length > 0) {
        // no selector block: the last path segment is the imported name
        if (names.length === 0 && path.length > 1) names.push(path[path.length - 1]!);
        imports.push({
          specifier: path.join('.'),
          names,
          startLine: node.startPosition.row + 1,
        });
      }
      return;
    }
    if (node.type === 'compilation_unit' || node.type === 'package_clause') {
      for (const child of node.namedChildren) if (child) visit(child);
    }
  };
  visit(tree.rootNode);
  return imports;
}

export const scalaExtractor: LanguageExtractor = {
  id: 'scala',
  symbolQuery: SCALA_QUERY,
  occurrenceQuery: SCALA_OCCURRENCES,
  extractImports,
  isExported,
  reclassify,
  bases,
};
