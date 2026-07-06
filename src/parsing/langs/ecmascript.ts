import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, SymbolBase, SymbolKind } from '../../types.js';

/**
 * Shared query fragments for the typescript / tsx / javascript grammars.
 * Pattern order matters: more specific patterns first (dedupe keeps the
 * lowest pattern index for a given definition node).
 */

// `const f = () => {}` / `const f = function () {}` — any depth; a named
// function value is a function wherever it lives.
const FN_VALUED_DECLARATOR = `
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression) (generator_function)]) @def.function
`;

// plain top-level bindings only (locals inside functions are noise)
const TOP_LEVEL_VARIABLES = `
  (program (lexical_declaration (variable_declarator name: (identifier) @name) @def.variable))
  (program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name) @def.variable)))
  (program (variable_declaration (variable_declarator name: (identifier) @name) @def.variable))
  (program (export_statement (variable_declaration (variable_declarator name: (identifier) @name) @def.variable)))
`;

const SHARED_FUNCTIONS = `
  (function_declaration name: (identifier) @name) @def.function
  (generator_function_declaration name: (identifier) @name) @def.function
  (method_definition name: (property_identifier) @name) @def.method
`;

const TS_ONLY = `
  (class_declaration name: (type_identifier) @name) @def.class
  (abstract_class_declaration name: (type_identifier) @name) @def.class
  (interface_declaration name: (type_identifier) @name) @def.interface
  (enum_declaration name: (identifier) @name) @def.enum
  (enum_body (property_identifier) @name @def.enum_member)
  (enum_assignment name: (property_identifier) @name) @def.enum_member
  (type_alias_declaration name: (type_identifier) @name) @def.type_alias
  (internal_module name: (identifier) @name) @def.namespace
  (interface_body (method_signature name: (property_identifier) @name) @def.method)
  (abstract_method_signature name: (property_identifier) @name) @def.method
  (interface_body (property_signature name: (property_identifier) @name) @def.property)
  (public_field_definition name: (property_identifier) @name) @def.field
`;

const JS_ONLY = `
  (class_declaration name: (identifier) @name) @def.class
  (field_definition property: (property_identifier) @name) @def.field
`;

const TS_QUERY = FN_VALUED_DECLARATOR + SHARED_FUNCTIONS + TS_ONLY + TOP_LEVEL_VARIABLES;
const JS_QUERY = FN_VALUED_DECLARATOR + SHARED_FUNCTIONS + JS_ONLY + TOP_LEVEL_VARIABLES;

const SHARED_OCCURRENCES = `
  (call_expression function: (identifier) @call)
  (call_expression function: (member_expression property: (property_identifier) @call))
  (new_expression constructor: (identifier) @call)
  (assignment_expression left: (identifier) @write)
  (assignment_expression left: (member_expression property: (property_identifier) @write))
  (augmented_assignment_expression left: (identifier) @write)
  (identifier) @ref
  (property_identifier) @ref
  (shorthand_property_identifier) @ref
`;
const TS_OCCURRENCES = `${SHARED_OCCURRENCES}
  (type_identifier) @ref
`;

function isExported(defNode: Node): boolean {
  for (let n: Node | null = defNode; n; n = n.parent) {
    if (n.type === 'export_statement') return true;
    if (n.type === 'program') return false;
  }
  return false;
}

/** Base names from `extends`/`implements` clauses on classes and interfaces. */
function bases(defNode: Node): SymbolBase[] {
  const out: SymbolBase[] = [];
  for (const child of defNode.namedChildren) {
    if (child?.type === 'class_heritage') {
      for (const clause of child.namedChildren) {
        if (clause?.type === 'extends_clause') {
          const value = clause.childForFieldName('value');
          if (value) out.push({ name: value.text, kind: 'extends' });
        } else if (clause?.type === 'implements_clause') {
          for (const t of clause.namedChildren) {
            if (t?.type === 'type_identifier' || t?.type === 'generic_type' || t?.type === 'nested_type_identifier') {
              out.push({ name: baseTypeName(t.text), kind: 'implements' });
            }
          }
        } else if (clause?.type === 'identifier' || clause?.type === 'member_expression') {
          // JS grammar: class_heritage wraps the value directly
          out.push({ name: clause.text, kind: 'extends' });
        }
      }
    } else if (child?.type === 'extends_type_clause') {
      // interface X extends A, B
      for (const t of child.namedChildren) {
        if (t) out.push({ name: baseTypeName(t.text), kind: 'extends' });
      }
    } else if (child?.type === 'extends_clause') {
      // JS grammar: class_heritage is just (extends_clause) without the wrapper
      const value = child.childForFieldName('value') ?? child.namedChildren[0];
      if (value) out.push({ name: baseTypeName(value.text), kind: 'extends' });
    }
  }
  return out;
}

/** Strip generic arguments: `Base<T>` -> `Base`. */
function baseTypeName(text: string): string {
  const lt = text.indexOf('<');
  return (lt === -1 ? text : text.slice(0, lt)).trim();
}

function reclassify(kind: SymbolKind, name: string, parentKind: SymbolKind | null): SymbolKind {
  if (kind === 'method' && name === 'constructor') return 'constructor';
  if (kind === 'function' && (parentKind === 'class' || parentKind === 'interface')) {
    return 'method';
  }
  return kind;
}

function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'import_statement') {
      const sourceNode = node.childForFieldName('source');
      const frag = sourceNode?.namedChildren.find((c) => c?.type === 'string_fragment');
      const specifier = frag?.text ?? sourceNode?.text.replace(/^['"]|['"]$/g, '') ?? '';
      const names: string[] = [];
      for (const child of node.namedChildren) {
        if (child?.type !== 'import_clause') continue;
        for (const binding of child.namedChildren) {
          if (!binding) continue;
          if (binding.type === 'identifier') {
            names.push(binding.text); // default import
          } else if (binding.type === 'namespace_import') {
            const id = binding.namedChildren.find((c) => c?.type === 'identifier');
            if (id) names.push(id.text);
          } else if (binding.type === 'named_imports') {
            for (const spec of binding.namedChildren) {
              if (spec?.type !== 'import_specifier') continue;
              const bound = spec.childForFieldName('alias') ?? spec.childForFieldName('name');
              if (bound) names.push(bound.text);
            }
          }
        }
      }
      if (specifier) {
        imports.push({ specifier, names, startLine: node.startPosition.row + 1 });
      }
      return; // no imports nested inside an import statement
    }
    // imports are (almost) always top-level statements; only recurse at the top
    if (node.type === 'program') {
      for (const child of node.namedChildren) if (child) visit(child);
    }
  };
  visit(tree.rootNode);
  return imports;
}

function makeExtractor(
  id: 'typescript' | 'tsx' | 'javascript',
  query: string,
  occurrenceQuery: string,
): LanguageExtractor {
  return { id, symbolQuery: query, occurrenceQuery, extractImports, isExported, reclassify, bases };
}

export const typescriptExtractor = makeExtractor('typescript', TS_QUERY, TS_OCCURRENCES);
export const tsxExtractor = makeExtractor('tsx', TS_QUERY, TS_OCCURRENCES);
export const javascriptExtractor = makeExtractor('javascript', JS_QUERY, SHARED_OCCURRENCES);
