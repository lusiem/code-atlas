import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, SymbolBase, SymbolKind } from '../../types.js';

// Notes on the grammar (PrestonKnopp/tree-sitter-gdscript, vendored wasm):
// inner-class bodies are (class_body), function bodies (body); `func _init`
// parses as constructor_definition with NO name field — its "_init" anonymous
// token is captured instead; annotations (@export/@onready) are children of
// the variable_statement, so signatures naturally include them.
const GD_QUERY = `
  (class_name_statement name: (name) @name) @def.class
  (class_definition name: (name) @name) @def.class
  (function_definition name: (name) @name) @def.function
  (constructor_definition "_init" @name) @def.constructor
  (signal_statement name: (name) @name) @def.signal
  (enum_definition name: (name) @name) @def.enum
  (enum_definition body: (enumerator_list (enumerator left: (identifier) @name) @def.enum_member))
  (source (variable_statement name: (name) @name) @def.variable)
  (class_definition body: (class_body (variable_statement name: (name) @name) @def.field))
  (source (const_statement name: (name) @name) @def.constant)
  (class_definition body: (class_body (const_statement name: (name) @name) @def.constant))
`;

const GD_OCCURRENCES = `
  (call (identifier) @call)
  (attribute_call (identifier) @call)
  (assignment left: (identifier) @write)
  (identifier) @ref
`;

/** `class Inner extends Base:` / script-level `extends Base` next to class_name. */
function bases(defNode: Node): SymbolBase[] {
  const out: SymbolBase[] = [];
  const scan = (holder: Node | null): void => {
    for (const child of holder?.namedChildren ?? []) {
      if (child?.type !== 'extends_statement') continue;
      for (const t of child.namedChildren) {
        if (t?.type === 'type') out.push({ name: t.text, kind: 'extends' });
      }
    }
  };
  if (defNode.type === 'class_definition') scan(defNode);
  if (defNode.type === 'class_name_statement') scan(defNode.parent); // sibling extends
  return out;
}

/** Preceding `##` (doc) or `#` comment lines. */
function docComment(defNode: Node, _source: string): string | null {
  const pieces: string[] = [];
  let prev = defNode.previousNamedSibling;
  let expectedEndRow = defNode.startPosition.row - 1;
  while (prev && prev.type === 'comment') {
    if (prev.endPosition.row < expectedEndRow) break;
    pieces.unshift(prev.text);
    expectedEndRow = prev.startPosition.row - 1;
    prev = prev.previousNamedSibling;
  }
  if (pieces.length === 0) return null;
  const cleaned = pieces
    .map((line) => line.replace(/^\s*##?\s?/, '').trimEnd())
    .join('\n')
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > 1000 ? `${cleaned.slice(0, 1000)}…` : cleaned;
}

function isExported(_defNode: Node, nameText: string): boolean {
  return !nameText.startsWith('_');
}

function reclassify(kind: SymbolKind, _name: string, parentKind: SymbolKind | null): SymbolKind {
  if (kind === 'function' && parentKind === 'class') return 'method';
  return kind;
}

/**
 * Imports: `extends "res://…"`, plus preload()/load() calls anywhere.
 * res:// specifiers are resolved against the Godot project root by the resolver.
 */
function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'extends_statement') {
      const str = node.namedChildren.find((c) => c?.type === 'string');
      if (str) {
        imports.push({
          specifier: stripQuotes(str.text),
          names: [],
          startLine: node.startPosition.row + 1,
        });
      }
      return;
    }
    if (node.type === 'call') {
      const fn = node.namedChildren[0];
      if (fn?.type === 'identifier' && (fn.text === 'preload' || fn.text === 'load')) {
        const arg = node.childForFieldName('arguments')?.namedChildren[0];
        if (arg?.type === 'string') {
          imports.push({
            specifier: stripQuotes(arg.text),
            names: [],
            startLine: node.startPosition.row + 1,
          });
        }
      }
    }
    for (const child of node.namedChildren) {
      if (child && child.namedChildCount > 0) visit(child);
    }
  };
  visit(tree.rootNode);
  return imports;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

export const gdscriptExtractor: LanguageExtractor = {
  id: 'gdscript',
  symbolQuery: GD_QUERY,
  occurrenceQuery: GD_OCCURRENCES,
  extractImports,
  isExported,
  reclassify,
  docComment,
  bases,
};
