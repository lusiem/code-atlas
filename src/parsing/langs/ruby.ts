import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, SymbolBase, SymbolKind } from '../../types.js';

const RUBY_QUERY = `
  (class name: (constant) @name) @def.class
  (module name: (constant) @name) @def.module
  (method name: (identifier) @name) @def.method
  (singleton_method name: (identifier) @name) @def.method
  (assignment left: (constant) @name) @def.constant
`;

// everything in Ruby is a method call — the per-language ubiquitous-name set
// in the resolver carries the noise-suppression load here
const RUBY_OCCURRENCES = `
  (call method: (identifier) @call)
  (assignment left: (identifier) @write)
  (assignment left: (instance_variable) @write)
  (identifier) @ref
  (constant) @ref
`;

function reclassify(kind: SymbolKind, name: string, parentKind: SymbolKind | null): SymbolKind {
  if (kind === 'method' && name === 'initialize') return 'constructor';
  if (kind === 'method' && parentKind === null) return 'function';
  return kind;
}

/** `< BaseService` -> extends; `include`/`prepend`/`extend` mixins -> implements. */
function bases(defNode: Node): SymbolBase[] {
  const out: SymbolBase[] = [];
  const superclass = defNode.namedChildren.find((c) => c?.type === 'superclass');
  const superName = superclass?.namedChildren.find(
    (c) => c?.type === 'constant' || c?.type === 'scope_resolution',
  );
  if (superName) out.push({ name: lastConst(superName.text), kind: 'extends' });

  const body = defNode.childForFieldName('body');
  for (const stmt of body?.namedChildren ?? []) {
    if (stmt?.type !== 'call') continue;
    const method = stmt.childForFieldName('method');
    if (!method || !['include', 'prepend', 'extend'].includes(method.text)) continue;
    if (stmt.childForFieldName('receiver')) continue; // obj.include is not a mixin
    const args = stmt.childForFieldName('arguments');
    for (const arg of args?.namedChildren ?? []) {
      if (arg?.type === 'constant' || arg?.type === 'scope_resolution') {
        out.push({ name: lastConst(arg.text), kind: 'implements' });
      }
    }
  }
  return out;
}

/** `A::B::C` -> `C`. */
function lastConst(text: string): string {
  const idx = text.lastIndexOf('::');
  return idx === -1 ? text : text.slice(idx + 2);
}

/** Top-level `require` / `require_relative` calls with literal string arguments. */
function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  for (const node of tree.rootNode.namedChildren) {
    if (node?.type !== 'call') continue;
    const method = node.childForFieldName('method');
    if (!method || (method.text !== 'require' && method.text !== 'require_relative')) continue;
    const args = node.childForFieldName('arguments');
    const str = args?.namedChildren.find((c) => c?.type === 'string');
    const content = str?.namedChildren.find((c) => c?.type === 'string_content');
    if (!content) continue;
    imports.push({
      // keep the require flavor distinguishable for the resolver
      specifier: method.text === 'require_relative' ? `./${content.text.replace(/^\.\//, '')}` : content.text,
      names: [],
      startLine: node.startPosition.row + 1,
    });
  }
  return imports;
}

export const rubyExtractor: LanguageExtractor = {
  id: 'ruby',
  symbolQuery: RUBY_QUERY,
  occurrenceQuery: RUBY_OCCURRENCES,
  extractImports,
  // Ruby visibility (`private` as a stateful call) is invisible structurally;
  // everything reports as exported rather than guessing
  isExported: () => true,
  reclassify,
  bases,
};
