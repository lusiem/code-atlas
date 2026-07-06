import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import { cleanComment } from '../extractor.js';
import type { ExtractedImport, SymbolBase, SymbolKind } from '../../types.js';

const PY_QUERY = `
  (function_definition name: (identifier) @name) @def.function
  (class_definition name: (identifier) @name) @def.class
  (module (expression_statement (assignment left: (identifier) @name) @def.variable))
  (class_definition body: (block (expression_statement (assignment left: (identifier) @name) @def.field)))
`;

const PY_OCCURRENCES = `
  (call function: (identifier) @call)
  (call function: (attribute attribute: (identifier) @call))
  (assignment left: (identifier) @write)
  (assignment left: (attribute attribute: (identifier) @write))
  (augmented_assignment left: (identifier) @write)
  (identifier) @ref
`;

/** Base classes from `class Foo(Base, mixin.Other):`. */
function bases(defNode: Node): SymbolBase[] {
  if (defNode.type !== 'class_definition') return [];
  const superclasses = defNode.childForFieldName('superclasses');
  if (!superclasses) return [];
  const out: SymbolBase[] = [];
  for (const arg of superclasses.namedChildren) {
    if (arg?.type === 'identifier' || arg?.type === 'attribute') {
      out.push({ name: arg.text, kind: 'extends' });
    } else if (arg?.type === 'subscript') {
      // Generic[T] and friends — take the container name
      const value = arg.childForFieldName('value');
      if (value) out.push({ name: value.text, kind: 'extends' });
    }
  }
  return out;
}

function docComment(defNode: Node, _source: string): string | null {
  if (defNode.type === 'function_definition' || defNode.type === 'class_definition') {
    const body = defNode.childForFieldName('body');
    const first = body?.namedChildren[0];
    if (first?.type === 'expression_statement') {
      const str = first.namedChildren[0];
      if (str?.type === 'string') {
        const content = str.namedChildren
          .filter((c) => c?.type === 'string_content')
          .map((c) => c!.text)
          .join('');
        const trimmed = content.trim();
        return trimmed.length > 0 ? (trimmed.length > 1000 ? `${trimmed.slice(0, 1000)}…` : trimmed) : null;
      }
    }
    return null;
  }
  // variables/fields: preceding `#` comments
  const pieces: string[] = [];
  let prev = defNode.parent?.previousNamedSibling ?? null; // parent = expression_statement
  let expectedEndRow = (defNode.parent ?? defNode).startPosition.row - 1;
  while (prev && prev.type === 'comment') {
    if (prev.endPosition.row < expectedEndRow) break;
    pieces.unshift(prev.text);
    expectedEndRow = prev.startPosition.row - 1;
    prev = prev.previousNamedSibling;
  }
  return pieces.length > 0 ? cleanComment(pieces.join('\n')) : null;
}

/** Python has no `export`; treat non-underscore names as public. */
function isExported(defNode: Node, nameText: string): boolean {
  if (nameText.startsWith('_') && !nameText.startsWith('__')) return false;
  if (nameText.startsWith('__') && !nameText.endsWith('__')) return false;
  return true;
}

function reclassify(kind: SymbolKind, name: string, parentKind: SymbolKind | null): SymbolKind {
  if (kind === 'function' && parentKind === 'class') {
    return name === '__init__' || name === '__new__' ? 'constructor' : 'method';
  }
  return kind;
}

function extractImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'import_statement') {
      // import a.b, c as d  → one entry per module
      for (const child of node.namedChildren) {
        if (child?.type === 'dotted_name') {
          imports.push({
            specifier: child.text,
            names: [child.text.split('.')[0]!],
            startLine: node.startPosition.row + 1,
          });
        } else if (child?.type === 'aliased_import') {
          const mod = child.childForFieldName('name');
          const alias = child.childForFieldName('alias');
          if (mod) {
            imports.push({
              specifier: mod.text,
              names: [alias?.text ?? mod.text.split('.')[0]!],
              startLine: node.startPosition.row + 1,
            });
          }
        }
      }
    } else if (node.type === 'import_from_statement') {
      const mod = node.childForFieldName('module_name');
      const names: string[] = [];
      for (const child of node.namedChildren) {
        if (!child || (mod && child.id === mod.id)) continue;
        if (child?.type === 'dotted_name') names.push(child.text);
        else if (child?.type === 'aliased_import') {
          const alias = child.childForFieldName('alias');
          const orig = child.childForFieldName('name');
          names.push(alias?.text ?? orig?.text ?? '');
        } else if (child?.type === 'wildcard_import') names.push('*');
      }
      if (mod) {
        imports.push({
          specifier: mod.text,
          names: names.filter((n) => n.length > 0),
          startLine: node.startPosition.row + 1,
        });
      }
    } else {
      // imports can appear inside functions/conditionals; recurse into blocks
      for (const child of node.namedChildren) {
        if (child && (child.namedChildCount > 0 || child.type.includes('import'))) visit(child);
      }
    }
  };
  visit(tree.rootNode);
  return imports;
}

export const pythonExtractor: LanguageExtractor = {
  id: 'python',
  symbolQuery: PY_QUERY,
  occurrenceQuery: PY_OCCURRENCES,
  extractImports,
  isExported,
  reclassify,
  docComment,
  bases,
};
