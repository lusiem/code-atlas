import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, ExtractedSymbol, SymbolBase, SymbolKind } from '../../types.js';

/**
 * The swift grammar reuses `class_declaration` for class/struct/enum/actor
 * (keyword disambiguated in enrich from the signature) and for extensions
 * (whose name is a `user_type`, mapped to impl). `init` declarations are
 * anonymous in the grammar and skipped. Protocol conformance is structurally
 * indistinguishable from subclassing — every inheritance entry reports as
 * extends.
 */
const SWIFT_QUERY = `
  (class_declaration name: (user_type (type_identifier) @name)) @def.impl
  (class_declaration name: (type_identifier) @name) @def.class
  (protocol_declaration name: (type_identifier) @name) @def.interface
  (protocol_function_declaration name: (simple_identifier) @name) @def.method
  (protocol_property_declaration (pattern (simple_identifier) @name)) @def.property
  (function_declaration name: (simple_identifier) @name) @def.function
  (property_declaration (pattern (simple_identifier) @name)) @def.property
  (enum_entry (simple_identifier) @name) @def.enum_member
  (typealias_declaration name: (type_identifier) @name) @def.type_alias
`;

const SWIFT_OCCURRENCES = `
  (call_expression (simple_identifier) @call)
  (call_expression (navigation_expression suffix: (navigation_suffix suffix: (simple_identifier) @call)))
  (assignment target: (directly_assignable_expression (simple_identifier) @write))
  (simple_identifier) @ref
  (type_identifier) @ref
`;

/** class_declaration keyword -> struct/enum/actor; extensions already impl. */
function enrich(symbols: ExtractedSymbol[], _source: string): void {
  for (const sym of symbols) {
    if (sym.kind !== 'class') continue;
    const kw = /\b(class|struct|enum|actor|extension)\b/.exec(sym.signature ?? '');
    if (kw?.[1] === 'struct') sym.kind = 'struct';
    else if (kw?.[1] === 'enum') sym.kind = 'enum';
    else if (kw?.[1] === 'extension') sym.kind = 'impl';
  }
}

function isExported(defNode: Node): boolean {
  const modifiers = defNode.namedChildren.find((c) => c?.type === 'modifiers');
  for (const m of modifiers?.namedChildren ?? []) {
    if (m?.type === 'visibility_modifier' && (m.text === 'private' || m.text === 'fileprivate')) {
      return false;
    }
  }
  return true;
}

function bases(defNode: Node): SymbolBase[] {
  const out: SymbolBase[] = [];
  for (const child of defNode.namedChildren) {
    if (child?.type !== 'inheritance_specifier') continue;
    const type = child.namedChildren.find((c) => c?.type === 'user_type');
    if (type) out.push({ name: type.text.replace(/<.*$/, ''), kind: 'extends' });
  }
  return out;
}

function reclassify(kind: SymbolKind, _name: string, parentKind: SymbolKind | null): SymbolKind {
  if (
    kind === 'function' &&
    (parentKind === 'class' || parentKind === 'struct' || parentKind === 'enum' || parentKind === 'impl' || parentKind === 'interface')
  ) {
    return 'method';
  }
  return kind;
}

/** `import Foundation` — module-level, never workspace-resolvable. */
function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  for (const node of tree.rootNode.namedChildren) {
    if (node?.type !== 'import_declaration') continue;
    const id = node.namedChildren.find((c) => c?.type === 'identifier');
    if (id) imports.push({ specifier: id.text, names: [], startLine: node.startPosition.row + 1 });
  }
  return imports;
}

export const swiftExtractor: LanguageExtractor = {
  id: 'swift',
  symbolQuery: SWIFT_QUERY,
  occurrenceQuery: SWIFT_OCCURRENCES,
  extractImports,
  enrich,
  isExported,
  reclassify,
  bases,
};
