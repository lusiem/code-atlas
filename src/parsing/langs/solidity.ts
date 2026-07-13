import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, SymbolBase, SymbolKind } from '../../types.js';

/**
 * Contracts map to classes, events to signals (searchable via
 * search_reflection like Godot signals), modifiers to functions. Constructors
 * are anonymous in the grammar and skipped — `constructor(...)` has no name
 * node to bind.
 */
const SOLIDITY_QUERY = `
  (contract_declaration name: (identifier) @name) @def.class
  (interface_declaration name: (identifier) @name) @def.interface
  (library_declaration name: (identifier) @name) @def.namespace
  (struct_declaration name: (identifier) @name) @def.struct
  (struct_member name: (identifier) @name) @def.field
  (enum_declaration name: (identifier) @name) @def.enum
  (enum_value) @name @def.enum_member
  (event_definition name: (identifier) @name) @def.signal
  (error_declaration name: (identifier) @name) @def.constant
  (modifier_definition name: (identifier) @name) @def.function
  (function_definition name: (identifier) @name) @def.function
  (state_variable_declaration name: (identifier) @name) @def.field
`;

const SOLIDITY_OCCURRENCES = `
  (call_expression function: (expression (identifier) @call))
  (call_expression function: (expression (member_expression property: (identifier) @call)))
  (emit_statement (expression (identifier) @call))
  (user_defined_type (identifier) @ref)
  (identifier) @ref
`;

function isExported(defNode: Node): boolean {
  for (const child of defNode.namedChildren) {
    if (child?.type === 'visibility' && (child.text === 'private' || child.text === 'internal')) {
      return false;
    }
  }
  return true;
}

function bases(defNode: Node): SymbolBase[] {
  const out: SymbolBase[] = [];
  for (const child of defNode.namedChildren) {
    if (child?.type !== 'inheritance_specifier') continue;
    const type = child.namedChildren.find((c) => c?.type === 'user_defined_type');
    if (type) out.push({ name: type.text, kind: 'extends' });
  }
  return out;
}

function reclassify(kind: SymbolKind, _name: string, parentKind: SymbolKind | null): SymbolKind {
  if (kind === 'function' && (parentKind === 'class' || parentKind === 'interface' || parentKind === 'namespace')) {
    return 'method';
  }
  return kind;
}

/** `import "./Base.sol";` and `import {A} from "./x.sol";` */
function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  for (const node of tree.rootNode.namedChildren) {
    if (node?.type !== 'import_directive') continue;
    const str = node.namedChildren.find((c) => c?.type === 'string');
    if (!str) continue;
    const names = node.namedChildren
      .filter((c) => c?.type === 'identifier')
      .map((c) => c!.text);
    imports.push({
      specifier: str.text.replace(/^['"]|['"]$/g, ''),
      names,
      startLine: node.startPosition.row + 1,
    });
  }
  return imports;
}

export const solidityExtractor: LanguageExtractor = {
  id: 'solidity',
  symbolQuery: SOLIDITY_QUERY,
  occurrenceQuery: SOLIDITY_OCCURRENCES,
  extractImports,
  isExported,
  reclassify,
  bases,
};
