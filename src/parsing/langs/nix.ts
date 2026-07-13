import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport } from '../../types.js';

/**
 * Nix's symbol model is bindings: `name = value` in let-blocks and attrsets.
 * Function-valued bindings surface as functions. `import ./x.nix` is the
 * language's whole dependency mechanism, so get_dependencies earns its keep.
 */
const NIX_QUERY = `
  (binding (attrpath (identifier) @name) (function_expression)) @def.function
  (binding (attrpath (identifier) @name)) @def.variable
`;

const NIX_OCCURRENCES = `
  (apply_expression (variable_expression (identifier) @call))
  (variable_expression (identifier) @ref)
`;

/** `import ./helpers.nix` / `import ./dir` anywhere in the expression tree. */
function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const seen = new Set<string>();
  const visit = (node: Node): void => {
    if (node.type === 'apply_expression') {
      const fn = node.namedChildren[0];
      const arg = node.namedChildren[1];
      if (
        fn?.type === 'variable_expression' &&
        fn.text === 'import' &&
        arg?.type === 'path_expression'
      ) {
        const key = `${arg.text}:${node.startPosition.row}`;
        if (!seen.has(key)) {
          seen.add(key);
          imports.push({ specifier: arg.text, names: [], startLine: node.startPosition.row + 1 });
        }
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(tree.rootNode);
  return imports;
}

export const nixExtractor: LanguageExtractor = {
  id: 'nix',
  symbolQuery: NIX_QUERY,
  occurrenceQuery: NIX_OCCURRENCES,
  extractImports,
  isExported: () => true,
};
