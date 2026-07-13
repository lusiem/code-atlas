import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, SymbolBase, SymbolKind } from '../../types.js';

/**
 * Dart signatures and bodies are sibling nodes (method_signature +
 * function_body), so a symbol's range covers the signature only — calls
 * inside the body attach to the enclosing class rather than the method.
 * Known structural limitation. Privacy is the `_` name prefix.
 */
const DART_QUERY = `
  (class_definition name: (identifier) @name) @def.class
  (mixin_declaration (identifier) @name) @def.trait
  (enum_declaration name: (identifier) @name) @def.enum
  (enum_constant name: (identifier) @name) @def.enum_member
  (extension_declaration name: (identifier) @name) @def.impl
  (type_alias (type_identifier) @name) @def.type_alias
  (constructor_signature . (identifier) @name) @def.constructor
  (getter_signature name: (identifier) @name) @def.property
  (setter_signature name: (identifier) @name) @def.property
  (function_signature name: (identifier) @name) @def.function
  (initialized_identifier (identifier) @name) @def.field
  (static_final_declaration (identifier) @name) @def.constant
`;

const DART_OCCURRENCES = `
  (_ (identifier) @call . (selector (argument_part)))
  (_ (selector (unconditional_assignable_selector (identifier) @call)) . (selector (argument_part)))
  (assignment_expression (assignable_expression (identifier) @write))
  (identifier) @ref
  (type_identifier) @ref
`;

function bases(defNode: Node): SymbolBase[] {
  const out: SymbolBase[] = [];
  for (const child of defNode.namedChildren) {
    if (child?.type === 'superclass') {
      for (const t of child.namedChildren) {
        if (t?.type === 'type_identifier') out.push({ name: t.text, kind: 'extends' });
        else if (t?.type === 'mixins') {
          for (const m of t.namedChildren) {
            if (m?.type === 'type_identifier') out.push({ name: m.text, kind: 'implements' });
          }
        }
      }
    } else if (child?.type === 'interfaces') {
      for (const t of child.namedChildren) {
        if (t?.type === 'type_identifier') out.push({ name: t.text, kind: 'implements' });
      }
    }
  }
  return out;
}

function reclassify(kind: SymbolKind, _name: string, parentKind: SymbolKind | null): SymbolKind {
  if (kind === 'function' && (parentKind === 'class' || parentKind === 'trait' || parentKind === 'impl')) {
    return 'method';
  }
  return kind;
}

/** Dart privacy: a leading underscore means library-private. */
function isExported(_defNode: Node, nameText: string): boolean {
  return !nameText.startsWith('_');
}

/** `/// docs` use a dedicated documentation_comment node. */
function docComment(defNode: Node): string | null {
  // signatures wrap in declaration/method_signature layers; comments attach at
  // the outermost statement level
  let anchor: Node = defNode;
  while (
    anchor.parent &&
    ['declaration', 'method_signature', 'function_signature', 'class_body', 'program'].includes(anchor.parent.type) === false
  ) {
    anchor = anchor.parent;
  }
  if (anchor.parent && (anchor.parent.type === 'declaration' || anchor.parent.type === 'method_signature')) {
    anchor = anchor.parent;
    if (anchor.parent?.type === 'declaration') anchor = anchor.parent;
  }
  const pieces: string[] = [];
  let prev = anchor.previousNamedSibling;
  let expectedEndRow = anchor.startPosition.row - 1;
  while (prev && (prev.type === 'documentation_comment' || prev.type === 'comment')) {
    if (prev.endPosition.row < expectedEndRow) break;
    pieces.unshift(prev.text);
    expectedEndRow = prev.startPosition.row - 1;
    prev = prev.previousNamedSibling;
  }
  if (pieces.length === 0) return null;
  const cleaned = pieces
    .join('\n')
    .split('\n')
    .map((line) => line.replace(/^\s*\/{2,3}\s?/, '').trimEnd())
    .join('\n')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** `import 'package:app/x.dart'` / relative `'./util.dart'`. */
function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'uri') {
      const spec = node.text.replace(/^['"]|['"]$/g, '');
      imports.push({ specifier: spec, names: [], startLine: node.startPosition.row + 1 });
      return;
    }
    if (['program', 'import_or_export', 'library_import', 'library_export', 'import_specification', 'configurable_uri'].includes(node.type)) {
      for (const child of node.namedChildren) if (child) visit(child);
    }
  };
  visit(tree.rootNode);
  return imports;
}

export const dartExtractor: LanguageExtractor = {
  id: 'dart',
  symbolQuery: DART_QUERY,
  occurrenceQuery: DART_OCCURRENCES,
  extractImports,
  isExported,
  reclassify,
  docComment,
  bases,
};
