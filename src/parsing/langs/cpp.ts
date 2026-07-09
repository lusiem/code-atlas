import type { Node, Tree } from 'web-tree-sitter';
import type { LanguageExtractor } from '../extractor.js';
import type { ExtractedImport, ExtractedSymbol, SymbolBase, SymbolKind } from '../../types.js';

/**
 * C++ (also used, minus C++-only node types, as the template for C).
 * Function declarators nest (`int *f()` = pointer_declarator > function_declarator),
 * so the common one-level wrappers get their own patterns.
 */
const CPP_QUERY = `
  (function_definition declarator: (function_declarator declarator: (identifier) @name)) @def.function
  (function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @def.function
  (function_definition declarator: (reference_declarator (function_declarator declarator: (identifier) @name))) @def.function
  (function_definition declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))) @def.method
  (function_definition declarator: (function_declarator declarator: (field_identifier) @name)) @def.method
  (declaration declarator: (function_declarator declarator: (identifier) @name)) @def.function
  (field_declaration declarator: (function_declarator declarator: (field_identifier) @name)) @def.method
  (class_specifier name: (type_identifier) @name body: (_)) @def.class
  (struct_specifier name: (type_identifier) @name body: (_)) @def.struct
  (union_specifier name: (type_identifier) @name body: (_)) @def.struct
  (enum_specifier name: (type_identifier) @name body: (_)) @def.enum
  (enumerator name: (identifier) @name) @def.enum_member
  (namespace_definition name: (namespace_identifier) @name) @def.namespace
  (field_declaration declarator: (field_identifier) @name) @def.field
  (field_declaration declarator: (pointer_declarator declarator: (field_identifier) @name)) @def.field
  (type_definition declarator: (type_identifier) @name) @def.type_alias
  (alias_declaration name: (type_identifier) @name) @def.type_alias
  (preproc_def name: (identifier) @name) @def.macro
  (preproc_function_def name: (identifier) @name) @def.macro
  (translation_unit (declaration declarator: (init_declarator declarator: (identifier) @name)) @def.variable)
  (namespace_definition body: (declaration_list (declaration declarator: (init_declarator declarator: (identifier) @name) @def.variable)))
`;

const CPP_OCCURRENCES = `
  (call_expression function: (identifier) @call)
  (call_expression function: (field_expression field: (field_identifier) @call))
  (call_expression function: (qualified_identifier name: (identifier) @call))
  (assignment_expression left: (identifier) @write)
  (assignment_expression left: (field_expression field: (field_identifier) @write))
  (identifier) @ref
  (field_identifier) @ref
  (type_identifier) @ref
  (namespace_identifier) @ref
`;

/**
 * Constructors parse as functions named like their class; out-of-class
 * qualified definitions arrive as methods already.
 */
function reclassify(
  kind: SymbolKind,
  name: string,
  parentKind: SymbolKind | null,
  parentName: string | null,
): SymbolKind {
  if (parentKind === 'class' || parentKind === 'struct') {
    if (name === parentName) return 'constructor';
    if (kind === 'function') return 'method';
  }
  return kind;
}

/** Bases from `class D : public B1, private B2`. */
function bases(defNode: Node): SymbolBase[] {
  if (defNode.type !== 'class_specifier' && defNode.type !== 'struct_specifier') return [];
  const out: SymbolBase[] = [];
  for (const child of defNode.namedChildren) {
    if (child?.type !== 'base_class_clause') continue;
    for (const base of child.namedChildren) {
      if (
        base?.type === 'type_identifier' ||
        base?.type === 'qualified_identifier' ||
        base?.type === 'template_type'
      ) {
        const lt = base.text.indexOf('<');
        out.push({ name: lt === -1 ? base.text : base.text.slice(0, lt), kind: 'extends' });
      }
    }
  }
  return out;
}

/** Shared by the C extractor. */
export function extractIncludeImports(tree: Tree, _source: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  for (const node of tree.rootNode.namedChildren) {
    if (node?.type !== 'preproc_include') continue;
    const path = node.childForFieldName('path');
    if (!path) continue;
    // "local.h" (resolvable) vs <system> (external); keep the delimiter info
    const specifier =
      path.type === 'system_lib_string'
        ? path.text // keep <...> so the resolver knows it is a system include
        : path.text.replace(/^"|"$/g, '');
    imports.push({ specifier, names: [], startLine: node.startPosition.row + 1 });
  }
  return imports;
}

/**
 * `class MYGAME_API AMyActor : ...` — the dllexport macro between the keyword
 * and the name breaks tree-sitter's class_specifier, losing the class and its
 * bases entirely (Unreal *_API, generic *_EXPORT). Blank it with spaces:
 * offsets are preserved, and collapsed signatures read cleanly.
 */
const EXPORT_MACRO_RE = /(\b(?:class|struct)\s+)([A-Z][A-Z0-9_]*_(?:API|EXPORT))(?=\s+[A-Za-z_])/g;

function preprocess(source: string): string {
  if (!/_API\b|_EXPORT\b/.test(source)) return source;
  return source.replace(EXPORT_MACRO_RE, (_m, head: string, macro: string) => head + ' '.repeat(macro.length));
}

/**
 * Unreal's GENERATED_BODY()/GENERATED_USTRUCT_BODY() parse as method
 * declarations, and the reflection macros themselves do too when their
 * specifiers get complex (UPROPERTY(..., Category = "X")). None are code.
 */
function skipSymbol(name: string): boolean {
  return (
    /^GENERATED_(?:[A-Z]+_)?BODY$/.test(name) ||
    /^(?:UCLASS|USTRUCT|UENUM|UINTERFACE|UFUNCTION|UPROPERTY|UDELEGATE)$/.test(name)
  );
}

const REFLECTION_MACRO_RE = /\b(UCLASS|USTRUCT|UENUM|UINTERFACE|UFUNCTION|UPROPERTY|UDELEGATE)\s*\(/g;

/**
 * Attach Unreal reflection macros to the declaration they annotate, as the
 * leading line(s) of its doc comment — searchable via FTS/search_reflection
 * and visible in get_symbol_info. Handles specifiers spanning lines
 * (`UPROPERTY(EditAnywhere,\n  meta = (...))`).
 */
function enrichUnrealReflection(symbols: ExtractedSymbol[], source: string): void {
  if (!REFLECTION_MACRO_RE.test(source)) return;
  REFLECTION_MACRO_RE.lastIndex = 0;

  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1; // 1-based
  };
  const isBlankLine = (line: number): boolean => {
    const start = lineStarts[line - 1]!;
    const end = line < lineStarts.length ? lineStarts[line]! : source.length;
    return source.slice(start, end).trim() === '';
  };

  const byStartLine = new Map<number, ExtractedSymbol[]>();
  for (const s of symbols) {
    const list = byStartLine.get(s.startLine) ?? [];
    list.push(s);
    byStartLine.set(s.startLine, list);
  }

  for (const m of source.matchAll(REFLECTION_MACRO_RE)) {
    // must be the first thing on its line — skips mentions in comments/strings
    const lineStart = lineStarts[lineOf(m.index) - 1]!;
    if (source.slice(lineStart, m.index).trim() !== '') continue;

    // matching close paren, macro args may span lines
    const openIdx = m.index + m[0].length - 1;
    let depth = 0;
    let closeIdx = -1;
    for (let k = openIdx; k < source.length && k - openIdx < 2000; k++) {
      if (source[k] === '(') depth++;
      else if (source[k] === ')' && --depth === 0) {
        closeIdx = k;
        break;
      }
    }
    if (closeIdx === -1) continue;
    const macroText = source.slice(m.index, closeIdx + 1).replace(/\s+/g, ' ');

    // the annotated declaration starts on the next non-blank line (or shares the macro's)
    let declLine = lineOf(closeIdx);
    if (!byStartLine.has(declLine)) {
      declLine++;
      while (declLine <= lineStarts.length && isBlankLine(declLine)) declLine++;
    }
    for (const sym of byStartLine.get(declLine) ?? []) {
      sym.docComment = sym.docComment ? `${macroText}\n${sym.docComment}` : macroText;
    }
  }
}

export const cppExtractor: LanguageExtractor = {
  id: 'cpp',
  symbolQuery: CPP_QUERY,
  occurrenceQuery: CPP_OCCURRENCES,
  preprocess,
  skipSymbol,
  enrich: enrichUnrealReflection,
  extractImports: extractIncludeImports,
  // structural layer cannot see access specifiers cheaply; headers are the
  // public surface in C++, so default everything to exported
  isExported: () => true,
  reclassify,
  bases,
};
