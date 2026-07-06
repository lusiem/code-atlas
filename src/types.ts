/** Canonical language identifiers. Must match grammars/tree-sitter-<id>.wasm filenames. */
export type LanguageId =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'c'
  | 'cpp'
  | 'rust'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'c_sharp'
  | 'gdscript';

export type SymbolKind =
  | 'function'
  | 'method'
  | 'constructor'
  | 'class'
  | 'interface'
  | 'trait'
  | 'struct'
  | 'enum'
  | 'enum_member'
  | 'type_alias'
  | 'variable'
  | 'constant'
  | 'property'
  | 'field'
  | 'namespace'
  | 'module'
  | 'signal'
  | 'macro'
  | 'impl';

/** How a type relates to a base named in its declaration. */
export type BaseKind = 'extends' | 'implements';

export interface SymbolBase {
  name: string;
  kind: BaseKind;
}

/**
 * Position convention everywhere in this codebase and the database:
 * lines are 1-based (matches editors and `path:line` links), columns are 0-based.
 */
export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  /** Declaration header without the body, single-line collapsed. */
  signature: string | null;
  docComment: string | null;
  /** Index into the extraction's symbols array of the enclosing symbol, or null. */
  parentIndex: number | null;
  isExported: boolean;
  /** Names this type declares as bases (extends/implements), unresolved. */
  bases: SymbolBase[];
}

export interface ExtractedImport {
  /** Raw module specifier as written: './util', 'react', 'os.path'. */
  specifier: string;
  /** Names bound by the import; empty for namespace/side-effect imports. */
  names: string[];
  startLine: number;
}

export type OccurrenceRole = 'ref' | 'call' | 'write' | 'import';

export type EdgeKind = 'calls' | 'imports' | 'extends' | 'implements' | 'overrides' | 'attaches';

export type EdgeProvenance = 'index' | 'lsp' | 'engine';

export interface ExtractedOccurrence {
  name: string;
  role: OccurrenceRole;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface FileExtraction {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  occurrences: ExtractedOccurrence[];
}

/** A symbol row as stored/returned from the database. */
export interface SymbolRow {
  id: number;
  fileId: number;
  path: string;
  lang: LanguageId;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  signature: string | null;
  docComment: string | null;
  parentSymbolId: number | null;
  isExported: boolean;
}
