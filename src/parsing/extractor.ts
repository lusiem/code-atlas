import type { Node, Tree } from 'web-tree-sitter';
import { compileQuery, parse } from './loader.js';
import type {
  ExtractedImport,
  ExtractedSymbol,
  FileExtraction,
  LanguageId,
  SymbolKind,
} from '../types.js';

/**
 * A language is described by a tags-style tree-sitter query plus small hooks.
 *
 * The symbol query follows one convention: every pattern captures the whole
 * definition node as `@def.<kind>` (kind = SymbolKind) and the name node as
 * `@name`. When several patterns match the same definition node, the one with
 * the lowest pattern index wins — so order patterns most-specific first.
 */
export interface LanguageExtractor {
  id: LanguageId;
  symbolQuery: string;
  /** Extract import statements by walking the tree (import shapes vary too much for one query convention). */
  extractImports?(tree: Tree, source: string): ExtractedImport[];
  isExported?(defNode: Node, nameText: string): boolean;
  /** Override doc-comment lookup (default: preceding // or /* sibling comments). */
  docComment?(defNode: Node, source: string): string | null;
  /** Adjust kind once the enclosing symbol is known (e.g. function in class -> method). */
  reclassify?(kind: SymbolKind, name: string, parentKind: SymbolKind | null): SymbolKind;
}

interface RawSymbol extends ExtractedSymbol {
  startIndex: number;
  endIndex: number;
}

export async function extractFile(
  extractor: LanguageExtractor,
  source: string,
): Promise<FileExtraction> {
  const tree = await parse(extractor.id, source);
  try {
    const query = await compileQuery(extractor.id, extractor.symbolQuery);
    const byDefNode = new Map<number, { raw: RawSymbol; patternIndex: number }>();

    for (const match of query.matches(tree.rootNode)) {
      let defNode: Node | null = null;
      let kind: SymbolKind | null = null;
      let nameNode: Node | null = null;
      for (const cap of match.captures) {
        if (cap.name.startsWith('def.')) {
          defNode = cap.node;
          kind = cap.name.slice(4) as SymbolKind;
        } else if (cap.name === 'name') {
          nameNode = cap.node;
        }
      }
      if (!defNode || !kind || !nameNode) continue;

      const prev = byDefNode.get(defNode.id);
      if (prev && prev.patternIndex <= match.patternIndex) continue;

      const name = nameNode.text;
      byDefNode.set(defNode.id, {
        patternIndex: match.patternIndex,
        raw: {
          name,
          kind,
          startLine: defNode.startPosition.row + 1,
          startCol: defNode.startPosition.column,
          endLine: defNode.endPosition.row + 1,
          endCol: defNode.endPosition.column,
          startIndex: defNode.startIndex,
          endIndex: defNode.endIndex,
          signature: buildSignature(defNode, source),
          docComment: extractor.docComment
            ? extractor.docComment(defNode, source)
            : precedingCommentDoc(defNode),
          parentIndex: null,
          isExported: extractor.isExported ? extractor.isExported(defNode, name) : false,
        },
      });
    }

    const symbols = [...byDefNode.values()].map((v) => v.raw);
    symbols.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
    assignParents(symbols);

    if (extractor.reclassify) {
      for (const sym of symbols) {
        const parentKind = sym.parentIndex === null ? null : symbols[sym.parentIndex]!.kind;
        sym.kind = extractor.reclassify(sym.kind, sym.name, parentKind);
      }
    }

    const imports = extractor.extractImports ? extractor.extractImports(tree, source) : [];

    return {
      symbols: symbols.map(({ startIndex: _s, endIndex: _e, ...sym }) => sym),
      imports,
      occurrences: [],
    };
  } finally {
    tree.delete();
  }
}

/** Stack-based containment pass over symbols sorted by (startIndex asc, endIndex desc). */
function assignParents(symbols: RawSymbol[]): void {
  const stack: number[] = [];
  symbols.forEach((sym, i) => {
    while (stack.length > 0 && symbols[stack[stack.length - 1]!]!.endIndex <= sym.startIndex) {
      stack.pop();
    }
    const top = stack[stack.length - 1];
    if (top !== undefined) {
      const parent = symbols[top]!;
      if (parent.startIndex <= sym.startIndex && parent.endIndex >= sym.endIndex) {
        sym.parentIndex = top;
      }
    }
    stack.push(i);
  });
}

/** Declaration header: definition text up to its body, collapsed to one line. */
function buildSignature(defNode: Node, source: string): string | null {
  const body = defNode.childForFieldName('body');
  let text: string;
  if (body && body.startIndex > defNode.startIndex) {
    text = source.slice(defNode.startIndex, body.startIndex);
  } else {
    const full = defNode.text;
    const nl = full.indexOf('\n');
    text = nl === -1 ? full : `${full.slice(0, nl)}…`;
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
}

/**
 * Default doc comment: contiguous preceding sibling comment(s).
 * Handles both a single block comment and a run of line comments.
 */
function precedingCommentDoc(defNode: Node): string | null {
  // For wrapped definitions (export const x = …, decorators), comments attach
  // to the outermost enclosing statement, so climb through wrapper nodes.
  const WRAPPERS = new Set([
    'export_statement',
    'lexical_declaration',
    'variable_declaration',
    'expression_statement',
    'decorated_definition',
    'labeled_statement',
  ]);
  let anchor: Node = defNode;
  while (anchor.parent && WRAPPERS.has(anchor.parent.type)) {
    anchor = anchor.parent;
  }
  const pieces: string[] = [];
  let prev = anchor.previousNamedSibling;
  let expectedEndRow = anchor.startPosition.row - 1;
  while (prev && prev.type === 'comment' && prev.endPosition.row >= expectedEndRow - 0) {
    if (prev.endPosition.row < expectedEndRow) break;
    pieces.unshift(prev.text);
    expectedEndRow = prev.startPosition.row - 1;
    prev = prev.previousNamedSibling;
  }
  if (pieces.length === 0) return null;
  return cleanComment(pieces.join('\n'));
}

export function cleanComment(text: string): string {
  const cleaned = text
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*(\*|\/\/\/?|#)\s?/, '').trimEnd())
    .join('\n')
    .trim();
  return cleaned.length > 1000 ? `${cleaned.slice(0, 1000)}…` : cleaned;
}
