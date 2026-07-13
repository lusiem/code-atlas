import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport } from '../../types.js';

/**
 * `function M.foo()` captures the trailing identifier as the name (the table
 * prefix stays visible in the signature); `M:bar` is a method. Locals inside
 * functions are noise — variable capture is anchored to the chunk.
 */
const LUA_QUERY = `
  (function_declaration (method_index_expression (identifier) (identifier) @name)) @def.method
  (function_declaration (dot_index_expression (identifier) (identifier) @name)) @def.function
  (function_declaration (identifier) @name) @def.function
  (chunk (variable_declaration (assignment_statement (variable_list (identifier) @name))) @def.variable)
  (chunk (assignment_statement (variable_list (identifier) @name)) @def.variable)
`;

const LUA_OCCURRENCES = `
  (function_call (identifier) @call)
  (function_call (dot_index_expression (identifier) (identifier) @call))
  (function_call (method_index_expression (identifier) (identifier) @call))
  (identifier) @ref
`;

/** `--- Adds numbers.` / `-- note` runs of preceding line comments. */
function docComment(defNode: Node): string | null {
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
    .join('\n')
    .split('\n')
    .map((line) => line.replace(/^\s*-{2,3}\s?/, '').trimEnd())
    .join('\n')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** `local x = require("a.b")` — also bare `require "a.b"` statements. */
function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'function_call') {
      const fn = node.namedChildren[0];
      if (fn?.type === 'identifier' && fn.text === 'require') {
        const args = node.namedChildren.find((c) => c?.type === 'arguments');
        const str = args?.namedChildren.find((c) => c?.type === 'string');
        const content = str?.namedChildren.find((c) => c?.type === 'string_content');
        if (content) {
          imports.push({ specifier: content.text, names: [], startLine: node.startPosition.row + 1 });
        }
        return;
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(tree.rootNode);
  return imports;
}

export const luaExtractor: LanguageExtractor = {
  id: 'lua',
  symbolQuery: LUA_QUERY,
  occurrenceQuery: LUA_OCCURRENCES,
  extractImports,
  docComment,
  isExported: (defNode) => !defNode.text.startsWith('local'),
};
