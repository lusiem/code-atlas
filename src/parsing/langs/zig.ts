import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, ExtractedSymbol } from '../../types.js';

/**
 * Zig containers are expressions (`const Point = struct {...}`), so the
 * container patterns bind the declaring variable's name. Inline `test` blocks
 * are string-named and skipped. Locals stay out via source_file/container
 * anchoring.
 */
const ZIG_QUERY = `
  (source_file (variable_declaration (identifier) @name (struct_declaration)) @def.struct)
  (source_file (variable_declaration (identifier) @name (enum_declaration)) @def.enum)
  (source_file (variable_declaration (identifier) @name (union_declaration)) @def.struct)
  (function_declaration (identifier) @name) @def.function
  (enum_declaration (container_field (identifier) @name) @def.enum_member)
  (struct_declaration (container_field (identifier) @name) @def.field)
  (source_file (variable_declaration (identifier) @name) @def.variable)
  (struct_declaration (variable_declaration (identifier) @name) @def.variable)
`;

const ZIG_OCCURRENCES = `
  (call_expression (identifier) @call)
  (call_expression (field_expression (identifier) @call))
  (identifier) @ref
`;

/** `const X = ...` is a constant; the grammar doesn't split const/var nodes. */
function enrich(symbols: ExtractedSymbol[], _source: string): void {
  for (const sym of symbols) {
    if (sym.kind === 'variable' && /^(pub\s+)?const\b/.test(sym.signature ?? '')) {
      sym.kind = 'constant';
    }
  }
}

function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'builtin_function') {
      const name = node.namedChildren.find((c) => c?.type === 'builtin_identifier');
      if (name?.text === '@import') {
        const args = node.namedChildren.find((c) => c?.type === 'arguments');
        const str = args?.namedChildren.find((c) => c?.type === 'string');
        const content = str?.namedChildren.find((c) => c?.type === 'string_content');
        if (content) {
          imports.push({ specifier: content.text, names: [], startLine: node.startPosition.row + 1 });
        }
      }
      return;
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(tree.rootNode);
  return imports;
}

export const zigExtractor: LanguageExtractor = {
  id: 'zig',
  symbolQuery: ZIG_QUERY,
  occurrenceQuery: ZIG_OCCURRENCES,
  extractImports,
  enrich,
  isExported: (defNode) => defNode.text.startsWith('pub'),
};
