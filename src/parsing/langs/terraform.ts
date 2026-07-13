import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport } from '../../types.js';

/**
 * Terraform's symbol model is blocks, not functions: `resource "type" "name"`
 * maps to a struct named by its last label (the type stays searchable through
 * the signature), variables/outputs/locals to variable/constant. `module`
 * blocks with a local `source` resolve like imports, so the module dependency
 * graph shows up in get_dependencies.
 */
const TF_QUERY = `
  ((block (identifier) @_kw (string_lit) (string_lit (template_literal) @name)) @def.struct
    (#eq? @_kw "resource"))
  ((block (identifier) @_kw (string_lit) (string_lit (template_literal) @name)) @def.struct
    (#eq? @_kw "data"))
  ((block (identifier) @_kw (string_lit (template_literal) @name)) @def.module
    (#eq? @_kw "module"))
  ((block (identifier) @_kw (string_lit (template_literal) @name)) @def.variable
    (#eq? @_kw "variable"))
  ((block (identifier) @_kw (string_lit (template_literal) @name)) @def.constant
    (#eq? @_kw "output"))
  ((block (identifier) @_kw (string_lit (template_literal) @name)) @def.namespace
    (#eq? @_kw "provider"))
  ((block (identifier) @_kw (body (attribute (identifier) @name) @def.variable))
    (#eq? @_kw "locals"))
`;

// `var.bucket_name` / `local.region` / `aws_s3_bucket.logs` — the first
// attribute after the root is the symbol-shaped name
const TF_OCCURRENCES = `
  (expression (variable_expr) . (get_attr (identifier) @ref))
`;

/** `module` blocks: `source = "./modules/net"` behaves like an import. */
function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'block') {
      const kw = node.namedChildren.find((c) => c?.type === 'identifier');
      if (kw?.text === 'module') {
        const body = node.namedChildren.find((c) => c?.type === 'body');
        for (const attr of body?.namedChildren ?? []) {
          if (attr?.type !== 'attribute') continue;
          const name = attr.namedChildren.find((c) => c?.type === 'identifier');
          if (name?.text !== 'source') continue;
          const lit = attr.descendantsOfType('template_literal')[0];
          if (lit) {
            imports.push({ specifier: lit.text, names: [], startLine: attr.startPosition.row + 1 });
          }
        }
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(tree.rootNode);
  return imports;
}

export const terraformExtractor: LanguageExtractor = {
  id: 'terraform',
  symbolQuery: TF_QUERY,
  occurrenceQuery: TF_OCCURRENCES,
  extractImports,
  isExported: () => true,
};
