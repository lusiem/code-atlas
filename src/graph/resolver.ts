import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportRow, Store, SymbolLite } from '../db/store.js';
import type { EdgeInsert } from '../db/store.js';
import type { EdgeKind, LanguageId } from '../types.js';

/**
 * Structural (index-only) resolution pass. Heuristic by design: everything it
 * writes carries a confidence score and provenance 'index'; the LSP layer
 * (Phase 4) overlays precise results where available.
 *
 * Confidence scale used throughout:
 *   0.90 explicitly imported name, found in the resolved target file
 *   0.85 unique match in the same file
 *   0.70 several same-file candidates / unique match in an imported file
 *   0.60 unique match across the whole workspace
 *   0.35 ambiguous: best of a small global candidate set
 */

const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'trait', 'enum', 'type_alias', 'impl']);

/**
 * Names so ubiquitous in a language (builtins, stdlib container/prototype
 * methods) that a cross-file heuristic match is almost certainly a false
 * positive: a workspace defining its own `super`, `forEach`, or `as_bytes`
 * would otherwise attract every such call in the codebase. These names still
 * resolve through the explicit-import and same-file tiers, which carry real
 * evidence; only the imported-files and workspace-global tiers are skipped.
 */
const JS_UBIQUITOUS = new Set([
  'forEach', 'map', 'filter', 'reduce', 'find', 'findIndex', 'some', 'every', 'includes',
  'indexOf', 'lastIndexOf', 'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat',
  'join', 'keys', 'values', 'entries', 'has', 'get', 'set', 'add', 'delete', 'clear', 'sort',
  'reverse', 'flat', 'flatMap', 'fill', 'toString', 'valueOf', 'hasOwnProperty', 'then',
  'catch', 'finally', 'split', 'replace', 'replaceAll', 'trim', 'charAt', 'charCodeAt',
  'substring', 'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase', 'padStart', 'padEnd',
  'repeat', 'match', 'test', 'exec', 'apply', 'call', 'bind',
]);
const JVM_UBIQUITOUS = new Set([
  'toString', 'equals', 'hashCode', 'get', 'set', 'put', 'add', 'remove', 'size', 'length',
  'isEmpty', 'contains', 'containsKey', 'iterator', 'next', 'hasNext', 'close', 'run', 'call',
  'apply', 'invoke', 'compareTo', 'clone', 'copy', 'valueOf', 'name', 'values', 'forEach',
  'stream', 'collect', 'map', 'filter', 'of', 'format', 'println', 'print', 'append',
  'charAt', 'substring', 'split', 'replace', 'trim', 'toLowerCase', 'toUpperCase',
  'startsWith', 'endsWith', 'indexOf', 'getBytes',
]);
const C_CPP_UBIQUITOUS = new Set([
  'c_str', 'size', 'length', 'empty', 'begin', 'end', 'push_back', 'pop_back', 'insert',
  'erase', 'clear', 'find', 'count', 'data', 'get', 'reset', 'release', 'at', 'front', 'back',
  'first', 'second', 'str', 'append', 'substr', 'swap', 'resize', 'reserve', 'emplace_back',
  'make_pair', 'make_unique', 'make_shared', 'move', 'forward', 'printf', 'sprintf',
  'snprintf', 'fprintf', 'sscanf', 'malloc', 'calloc', 'realloc', 'free', 'memcpy', 'memset',
  'memcmp', 'strlen', 'strcpy', 'strncpy', 'strcmp', 'strncmp', 'strdup', 'strchr', 'strstr',
  'fopen', 'fclose', 'fread', 'fwrite', 'assert', 'abort', 'exit',
]);
const UBIQUITOUS_NAMES: Partial<Record<LanguageId, ReadonlySet<string>>> = {
  typescript: JS_UBIQUITOUS,
  tsx: JS_UBIQUITOUS,
  javascript: JS_UBIQUITOUS,
  vue: JS_UBIQUITOUS,
  svelte: JS_UBIQUITOUS,
  python: new Set([
    // builtins
    'abs', 'all', 'any', 'ascii', 'bin', 'bool', 'bytearray', 'bytes', 'callable', 'chr',
    'classmethod', 'compile', 'complex', 'delattr', 'dict', 'dir', 'divmod', 'enumerate',
    'eval', 'exec', 'filter', 'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr',
    'hash', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list',
    'locals', 'map', 'max', 'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print',
    'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice', 'sorted',
    'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip',
    // common container/str methods
    'get', 'items', 'keys', 'values', 'update', 'append', 'extend', 'insert', 'remove',
    'pop', 'clear', 'copy', 'count', 'index', 'sort', 'reverse', 'add', 'join', 'split',
    'strip', 'startswith', 'endswith', 'replace', 'lower', 'upper', 'encode', 'decode',
    'read', 'write', 'close',
  ]),
  go: new Set([
    'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make',
    'max', 'min', 'new', 'panic', 'print', 'println', 'real', 'recover', 'String', 'Error',
  ]),
  rust: new Set([
    'new', 'default', 'clone', 'len', 'is_empty', 'iter', 'into_iter', 'iter_mut', 'collect',
    'map', 'and_then', 'or_else', 'unwrap', 'unwrap_or', 'unwrap_or_else', 'expect', 'push',
    'pop', 'insert', 'remove', 'get', 'get_mut', 'contains', 'contains_key', 'as_bytes',
    'as_str', 'as_ref', 'as_slice', 'to_string', 'to_owned', 'to_vec', 'borrow', 'borrow_mut',
    'into', 'from', 'try_from', 'try_into', 'next', 'write', 'read', 'flush', 'fmt', 'eq',
    'cmp', 'hash', 'drop',
  ]),
  java: JVM_UBIQUITOUS,
  kotlin: new Set([
    ...JVM_UBIQUITOUS,
    'let', 'also', 'with', 'use', 'to', 'takeIf', 'takeUnless', 'lazy', 'listOf', 'mapOf',
    'setOf', 'arrayOf', 'mutableListOf', 'mutableMapOf', 'mutableSetOf', 'emptyList',
    'emptyMap', 'emptySet', 'requireNotNull', 'checkNotNull', 'require', 'check', 'error',
  ]),
  c: C_CPP_UBIQUITOUS,
  cpp: C_CPP_UBIQUITOUS,
  c_sharp: new Set([
    'ToString', 'Equals', 'GetHashCode', 'GetType', 'Add', 'Remove', 'Contains', 'Clear',
    'Count', 'Dispose', 'Close', 'Read', 'Write', 'WriteLine', 'Parse', 'TryParse', 'Format',
    'Join', 'Split', 'Replace', 'Trim', 'ToLower', 'ToUpper', 'StartsWith', 'EndsWith',
    'IndexOf', 'Substring', 'Append', 'ToList', 'ToArray', 'Select', 'Where', 'First',
    'FirstOrDefault', 'Any', 'All', 'ContainsKey', 'TryGetValue', 'Invoke',
    // BCL type names commonly hit by `new X(...)` / type refs
    'List', 'Dictionary', 'HashSet', 'DateTime', 'DateTimeOffset', 'TimeSpan', 'Guid', 'Uri',
    'Task', 'String', 'StringBuilder', 'Console', 'Convert', 'Math', 'Array', 'Exception',
    'Stream', 'Object', 'Type', 'Action', 'Func', 'Tuple', 'Nullable',
  ]),
  gdscript: new Set([
    // annotations captured as identifiers + GDScript/Node builtins
    'export', 'export_range', 'export_enum', 'export_flags', 'export_group', 'export_category',
    'onready', 'tool', 'icon', 'rpc', 'warning_ignore',
    'preload', 'load', 'print', 'push_error', 'push_warning', 'assert', 'str', 'int', 'float',
    'range', 'len', 'abs', 'min', 'max', 'clamp', 'lerp', 'randf', 'randi',
    'emit', 'connect', 'disconnect', 'is_connected', 'emit_signal', 'call_deferred', 'bind',
    'new', 'free', 'queue_free', 'duplicate', 'instantiate',
    'get_node', 'has_node', 'get_parent', 'get_tree', 'get_children', 'add_child',
    'remove_child', 'set_process', 'set_physics_process', 'play', 'stop',
  ]),
  php: new Set([
    'count', 'in_array', 'array_map', 'array_filter', 'array_merge', 'array_keys',
    'array_values', 'array_key_exists', 'implode', 'explode', 'sprintf', 'printf',
    'str_replace', 'strlen', 'substr', 'strpos', 'trim', 'strtolower', 'strtoupper',
    'is_array', 'is_string', 'is_null', 'is_numeric', 'isset', 'empty', 'unset',
    'json_encode', 'json_decode', 'var_dump', 'print_r', 'die', 'exit', 'echo',
    'array_push', 'array_pop', 'array_shift', 'usort', 'sort', 'compact', 'extract',
    // pervasive method names
    'get', 'set', 'has', 'make', 'create', 'toArray', 'toString', 'render', 'handle',
  ]),
  ruby: new Set([
    // Kernel / Object staples — everything in Ruby is a call, so this set
    // carries the false-reference suppression load
    'puts', 'p', 'pp', 'print', 'raise', 'lambda', 'proc', 'require', 'require_relative',
    'attr_accessor', 'attr_reader', 'attr_writer', 'include', 'extend', 'prepend',
    'new', 'freeze', 'frozen?', 'dup', 'clone', 'send', 'public_send', 'respond_to?',
    'instance_variable_get', 'instance_variable_set', 'define_method', 'block_given?',
    'to_s', 'to_sym', 'to_a', 'to_h', 'to_i', 'to_f', 'inspect', 'hash', 'eql?', 'equal?',
    'each', 'each_with_index', 'each_with_object', 'map', 'flat_map', 'select', 'reject',
    'reduce', 'inject', 'detect', 'find', 'find_all', 'sort', 'sort_by', 'group_by',
    'first', 'last', 'push', 'pop', 'shift', 'unshift', 'length', 'size', 'empty?',
    'nil?', 'is_a?', 'kind_of?', 'instance_of?', 'key?', 'keys', 'values', 'merge',
    'fetch', 'dig', 'join', 'split', 'strip', 'gsub', 'sub', 'match', 'match?',
    'start_with?', 'end_with?', 'upcase', 'downcase', 'call', 'tap', 'then', 'yield_self',
  ]),
  lua: new Set([
    'print', 'pairs', 'ipairs', 'type', 'tostring', 'tonumber', 'pcall', 'xpcall', 'error',
    'assert', 'select', 'next', 'unpack', 'rawget', 'rawset', 'rawequal', 'require',
    'setmetatable', 'getmetatable', 'insert', 'remove', 'concat', 'format', 'gsub', 'gmatch',
    'match', 'find', 'sub', 'len', 'sort', 'floor', 'ceil', 'abs', 'max', 'min', 'random',
  ]),
  solidity: new Set([
    'require', 'assert', 'revert', 'keccak256', 'sha256', 'ripemd160', 'ecrecover',
    'addmod', 'mulmod', 'selfdestruct', 'blockhash', 'gasleft', 'payable', 'push', 'pop',
    'transfer', 'send', 'call', 'delegatecall', 'staticcall', 'encode', 'encodePacked',
    'encodeWithSelector', 'encodeWithSignature', 'decode', 'balance', 'length',
  ]),
  zig: new Set([
    // @-builtins are captured with their sigil and never collide; these are
    // pervasive std/method names
    'init', 'deinit', 'len', 'append', 'appendSlice', 'pop', 'items', 'allocator', 'alloc',
    'free', 'dupe', 'print', 'format', 'writeAll', 'write', 'read', 'next', 'get', 'put',
    'contains', 'count', 'clearRetainingCapacity', 'toOwnedSlice', 'slice', 'eql', 'expect',
    'expectEqual', 'expectError', 'parseInt', 'parseFloat', 'intCast', 'enumFromInt',
  ]),
  swift: new Set([
    'print', 'map', 'filter', 'reduce', 'compactMap', 'flatMap', 'forEach', 'append',
    'count', 'isEmpty', 'contains', 'first', 'last', 'sorted', 'joined', 'description',
    'hashValue', 'init', 'append', 'insert', 'remove', 'removeAll', 'index', 'dropFirst',
    'String', 'Int', 'Bool', 'Double', 'Float', 'Array', 'Dictionary', 'Set', 'Optional',
    'Error', 'Result', 'Data', 'URL', 'Date', 'UUID', 'Codable', 'Equatable', 'Hashable',
    'Comparable', 'Identifiable', 'CustomStringConvertible', 'Sendable',
  ]),
  scala: new Set([
    'println', 'print', 'map', 'flatMap', 'filter', 'filterNot', 'foreach', 'foldLeft',
    'foldRight', 'reduce', 'collect', 'apply', 'unapply', 'copy', 'toString', 'equals',
    'hashCode', 'head', 'tail', 'headOption', 'mkString', 'toList', 'toSeq', 'toMap',
    'toSet', 'getOrElse', 'orElse', 'isEmpty', 'nonEmpty', 'contains', 'exists', 'forall',
    'size', 'length', 'zip', 'take', 'drop', 'groupBy', 'sortBy', 'Some', 'None', 'Option',
    'List', 'Seq', 'Vector', 'Map', 'Set', 'Array', 'Future', 'Try', 'Either', 'Left', 'Right',
  ]),
  dart: new Set([
    'print', 'toString', 'map', 'where', 'forEach', 'add', 'addAll', 'remove', 'contains',
    'length', 'isEmpty', 'isNotEmpty', 'first', 'last', 'toList', 'toSet', 'join', 'split',
    'then', 'catchError', 'setState', 'build', 'dispose', 'initState', 'createState',
    'jsonEncode', 'jsonDecode', 'identical', 'call', 'noSuchMethod',
    'String', 'List', 'Map', 'Set', 'Future', 'Stream', 'Duration', 'Widget', 'BuildContext',
  ]),
  terraform: new Set([
    'var', 'local', 'module', 'each', 'count', 'self', 'terraform', 'data', 'path',
    'format', 'length', 'lookup', 'merge', 'concat', 'file', 'templatefile', 'toset',
    'tolist', 'tomap', 'jsonencode', 'jsondecode', 'coalesce', 'try', 'can', 'cidrsubnet',
    'value', 'key', 'name', 'id', 'arn', 'region', 'tags', 'type', 'default', 'source',
  ]),
  pascal: new Set([
    'WriteLn', 'ReadLn', 'Write', 'Read', 'Create', 'Free', 'Destroy', 'FreeAndNil',
    'Assigned', 'Result', 'Self', 'Length', 'SetLength', 'Copy', 'Inc', 'Dec', 'Ord',
    'Chr', 'High', 'Low', 'Exit', 'Break', 'Continue', 'Format', 'IntToStr', 'StrToInt',
    'FloatToStr', 'Trim', 'UpperCase', 'LowerCase', 'Pos', 'Delete', 'Insert', 'New',
    'Dispose', 'GetMem', 'FreeMem', 'SizeOf', 'Add', 'Remove', 'IndexOf', 'Clear', 'Count',
  ]),
  nix: new Set([
    'import', 'toString', 'map', 'filter', 'length', 'head', 'tail', 'elem', 'elemAt',
    'concatMap', 'attrNames', 'attrValues', 'hasAttr', 'getAttr', 'removeAttrs', 'listToAttrs',
    'mkDerivation', 'mkOption', 'mkIf', 'mkMerge', 'mkForce', 'mkDefault', 'mkEnableOption',
    'fetchFromGitHub', 'fetchurl', 'fetchgit', 'callPackage', 'writeText', 'writeShellScriptBin',
    'optional', 'optionals', 'optionalString', 'concatStringsSep', 'splitString', 'replaceStrings',
    'substring', 'stringLength', 'toJSON', 'fromJSON', 'throw', 'abort', 'trace', 'seq',
  ]),
};

function isUbiquitous(ws: WorkspaceIndex, fileId: number, name: string): boolean {
  const lang = ws.fileIdToLang.get(fileId);
  return lang !== undefined && (UBIQUITOUS_NAMES[lang]?.has(name) ?? false);
}

interface WorkspaceIndex {
  pathToFileId: Map<string, number>;
  fileIdToPath: Map<number, string>;
  fileIdToLang: Map<number, LanguageId>;
  /** name -> local symbols, per file. */
  fileSymbolsByName: Map<number, Map<string, SymbolLite[]>>;
  /** symbols per file ordered by position (for enclosing-symbol lookup). */
  fileSymbols: Map<number, SymbolLite[]>;
  globalByName: Map<string, SymbolLite[]>;
  /** local bound name -> imported-from file id, per file. */
  importedNames: Map<number, Map<string, number>>;
  /** all files a file imports (resolved only), per file. */
  importedFiles: Map<number, Set<number>>;
}

export interface ResolveStats {
  mode: 'full' | 'incremental';
  /** Files whose occurrences/bases were (re)resolved this pass. */
  files: number;
  imports: { total: number; resolved: number };
  occurrences: { total: number; resolved: number };
  edges: number;
}

/**
 * Compute the set of files whose resolutions a batch of changes can affect,
 * or null when the blast radius is large enough that a full pass is cheaper:
 * the changed files, importers of changed/removed files, and any file with an
 * occurrence of a name defined in the old or new version of the changed files
 * (covers global-tier resolutions and edges into replaced symbols).
 */
export function affectedFilesFor(
  store: Store,
  opts: {
    changedFileIds: Iterable<number>;
    importersOfRemoved: Iterable<number>;
    oldSymbolNames: ReadonlySet<string>;
  },
): Set<number> | null {
  const affected = new Set<number>(opts.changedFileIds);
  for (const id of store.filesImporting(affected)) affected.add(id);
  for (const id of opts.importersOfRemoved) affected.add(id);

  const names = new Set(opts.oldSymbolNames);
  for (const n of store.symbolNamesInFiles(opts.changedFileIds)) names.add(n);
  if (names.size > 4000) return null;
  for (const id of store.filesWithOccurrenceNames(names)) affected.add(id);

  // fall back to a full pass only when it would actually be expensive:
  // below the floor a scoped pass costs the same and keeps stats meaningful
  const totalFiles = store.listFiles().length;
  if (affected.size > Math.max(50, totalFiles / 2)) return null;
  return affected;
}

export async function resolveWorkspace(
  store: Store,
  rootDir: string,
  scope?: Set<number>,
): Promise<ResolveStats> {
  const files = store.listFiles();
  const pathToFileId = new Map(files.map((f) => [f.path, f.id]));
  const fileIdToPath = new Map(files.map((f) => [f.id, f.path]));
  const fileIdToLang = new Map(files.map((f) => [f.id, f.lang]));

  // 1. imports -> files (always global: a new file can satisfy anyone's import)
  const importRows = store.listImportRows();
  const manifests: Manifests = {
    goModule: readGoModule(rootDir),
    dartPackage: readDartPackage(rootDir),
    // Godot res:// paths are relative to their project.godot dir — a workspace
    // can hold many projects (monorepos of samples/games). Longest root first.
    godotRoots: store
      .listAssets()
      .filter((a) => a.kind === 'project')
      .map((a) => a.path.replace(/\/?project\.godot$/, ''))
      .sort((a, b) => b.length - a.length),
    composerPsr4: readComposerPsr4(rootDir),
    csharpNamespaceFiles: store.namespaceFilePaths('c_sharp'),
    swiftModuleFiles: swiftModuleDirs(pathToFileId.keys()),
  };
  const resolutions: Array<{ id: number; fileId: number | null }> = [];
  for (const imp of importRows) {
    const target = resolveImport(imp, pathToFileId, manifests);
    // a changed import target invalidates that file's occurrence resolutions
    if (scope && target !== imp.resolvedFileId) scope.add(imp.fileId);
    resolutions.push({ id: imp.id, fileId: target });
    imp.resolvedFileId = target;
  }
  store.applyImportResolutions(resolutions);

  // 2. build in-memory symbol tables
  const symbols = store.listSymbolsLite();
  const ws: WorkspaceIndex = {
    pathToFileId,
    fileIdToPath,
    fileIdToLang,
    fileSymbolsByName: new Map(),
    fileSymbols: new Map(),
    globalByName: new Map(),
    importedNames: new Map(),
    importedFiles: new Map(),
  };
  for (const sym of symbols) {
    let perFile = ws.fileSymbolsByName.get(sym.fileId);
    if (!perFile) ws.fileSymbolsByName.set(sym.fileId, (perFile = new Map()));
    push(perFile, sym.name, sym);
    push(ws.globalByName, sym.name, sym);
    let list = ws.fileSymbols.get(sym.fileId);
    if (!list) ws.fileSymbols.set(sym.fileId, (list = []));
    list.push(sym);
  }
  for (const list of ws.fileSymbols.values()) {
    list.sort((a, b) => a.startLine - b.startLine || a.startCol - b.startCol);
  }
  for (const imp of importRows) {
    if (imp.resolvedFileId === null) continue;
    let names = ws.importedNames.get(imp.fileId);
    if (!names) ws.importedNames.set(imp.fileId, (names = new Map()));
    for (const name of imp.names) {
      if (name !== '*') names.set(name, imp.resolvedFileId);
    }
    let targets = ws.importedFiles.get(imp.fileId);
    if (!targets) ws.importedFiles.set(imp.fileId, (targets = new Set()));
    targets.add(imp.resolvedFileId);
  }
  augmentModuleVisibility(ws, importRows, manifests);

  // 3. occurrences -> symbols (scoped to affected files when incremental)
  const occurrences = scope
    ? store.listOccurrenceRowsForFiles(scope)
    : store.listOccurrenceRows();
  const occResolutions: Array<{ id: number; symbolId: number; confidence: number }> = [];
  const edges: EdgeInsert[] = [];
  let processed = 0;
  for (const occ of occurrences) {
    // yield periodically so a large pass doesn't starve MCP requests
    if (++processed % 20000 === 0) await new Promise((r) => setImmediate(r));
    const hit = resolveName(ws, occ.fileId, occ.name, occ.role === 'call');
    if (!hit) continue;
    occResolutions.push({ id: occ.id, symbolId: hit.symbol.id, confidence: hit.confidence });
    if (occ.role === 'call') {
      const src = enclosingSymbol(ws, occ.fileId, occ.startLine, occ.startCol);
      if (src && src.id !== hit.symbol.id) {
        edges.push({
          srcSymbolId: src.id,
          dstSymbolId: hit.symbol.id,
          kind: 'calls',
          confidence: hit.confidence,
          provenance: 'index',
        });
      }
    }
  }
  // 4. declared bases -> extends/implements edges
  for (const sym of symbols) {
    if (scope && !scope.has(sym.fileId)) continue;
    for (const base of sym.bases) {
      const hit = resolveBase(ws, sym, base.name);
      if (!hit) continue;
      edges.push({
        srcSymbolId: sym.id,
        dstSymbolId: hit.symbol.id,
        kind: base.kind as EdgeKind,
        confidence: hit.confidence,
        provenance: 'index',
      });
    }
  }

  // atomic: clear stale state and write the new pass in one transaction so a
  // crash mid-pass can never strand the graph half-cleared
  store.applyResolutionPass(scope ?? null, occResolutions, edges);

  // 5. route handlers declared by name (Express fn refs, Django dotted paths).
  // Always the full unresolved set: reindexing the handler's file nulls the
  // link (ON DELETE SET NULL) even when the route's own file isn't in scope.
  for (const route of store.routesWithUnresolvedHandlers()) {
    const name = route.handlerName.split('.').pop();
    if (!name) continue;
    const candidates = store
      .symbolsByExactName(name)
      .filter((s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'class');
    const sameFile = candidates.filter((c) => c.fileId === route.fileId);
    const pick = sameFile.length === 1 ? sameFile[0] : candidates.length === 1 ? candidates[0] : null;
    if (pick) store.setRouteHandler(route.id, pick.id);
  }

  store.setMeta('resolved_at', String(Date.now()));

  return {
    mode: scope ? 'incremental' : 'full',
    files: scope ? scope.size : files.length,
    imports: {
      total: importRows.length,
      resolved: importRows.filter((i) => i.resolvedFileId !== null).length,
    },
    occurrences: { total: occurrences.length, resolved: occResolutions.length },
    edges: edges.length,
  };
}

function push<K>(map: Map<K, SymbolLite[]>, key: K, sym: SymbolLite): void {
  const list = map.get(key);
  if (list) list.push(sym);
  else map.set(key, [sym]);
}

interface Hit {
  symbol: SymbolLite;
  confidence: number;
}

/**
 * Candidate-ranked name resolution: explicit import > same file > imported
 * files > unique global > small ambiguous set.
 */
function resolveName(ws: WorkspaceIndex, fileId: number, name: string, isCall: boolean): Hit | null {
  // callable-ish kinds are preferred for call sites
  const prefer = (list: SymbolLite[]): SymbolLite[] => {
    if (!isCall) return list;
    const callable = list.filter(
      (s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'constructor' || s.kind === 'macro' || s.kind === 'class' || s.kind === 'struct',
    );
    return callable.length > 0 ? callable : list;
  };

  const importedFrom = ws.importedNames.get(fileId)?.get(name);
  if (importedFrom !== undefined) {
    const candidates = prefer(
      (ws.fileSymbolsByName.get(importedFrom)?.get(name) ?? []).filter((s) => s.isExported),
    );
    if (candidates.length > 0) return { symbol: candidates[0]!, confidence: 0.9 };
  }

  const local = prefer(ws.fileSymbolsByName.get(fileId)?.get(name) ?? []);
  if (local.length === 1) return { symbol: local[0]!, confidence: 0.85 };
  if (local.length > 1) return { symbol: local[0]!, confidence: 0.7 };

  // builtins/stdlib names: cross-file tiers are noise, not evidence
  if (isUbiquitous(ws, fileId, name)) return null;

  const importedFiles = ws.importedFiles.get(fileId);
  if (importedFiles) {
    const fromImports: SymbolLite[] = [];
    for (const target of importedFiles) {
      for (const s of ws.fileSymbolsByName.get(target)?.get(name) ?? []) {
        if (s.isExported) fromImports.push(s);
      }
    }
    const candidates = prefer(fromImports);
    if (candidates.length === 1) return { symbol: candidates[0]!, confidence: 0.7 };
    if (candidates.length > 1) return { symbol: lowestId(candidates), confidence: 0.5 };
  }

  const global = prefer((ws.globalByName.get(name) ?? []).filter((s) => s.isExported));
  if (global.length === 1) return { symbol: global[0]!, confidence: 0.6 };
  if (global.length > 1 && global.length <= 4) return { symbol: lowestId(global), confidence: 0.35 };
  return null;
}

/** Resolve a declared base-type name to a type symbol. */
function resolveBase(ws: WorkspaceIndex, sym: SymbolLite, rawName: string): Hit | null {
  // `ns::Base`, `pkg.Base`, `Base<T>` -> try the raw text, then the last segment
  const names = [rawName];
  const short = rawName.split(/::|\./).pop();
  if (short && short !== rawName) names.push(short);

  for (const name of names) {
    const typed = (list: SymbolLite[]): SymbolLite[] => list.filter((s) => TYPE_KINDS.has(s.kind) && s.id !== sym.id);

    const local = typed(ws.fileSymbolsByName.get(sym.fileId)?.get(name) ?? []);
    if (local.length > 0) return { symbol: local[0]!, confidence: 0.9 };

    const importedFrom = ws.importedNames.get(sym.fileId)?.get(name);
    if (importedFrom !== undefined) {
      const hits = typed(ws.fileSymbolsByName.get(importedFrom)?.get(name) ?? []);
      if (hits.length > 0) return { symbol: hits[0]!, confidence: 0.9 };
    }

    const fromImports: SymbolLite[] = [];
    for (const target of ws.importedFiles.get(sym.fileId) ?? []) {
      fromImports.push(...typed(ws.fileSymbolsByName.get(target)?.get(name) ?? []));
    }
    if (fromImports.length > 0) return { symbol: lowestId(fromImports), confidence: 0.85 };

    if (isUbiquitous(ws, sym.fileId, name)) continue;
    const global = typed((ws.globalByName.get(name) ?? []).filter((s) => s.isExported));
    if (global.length === 1) return { symbol: global[0]!, confidence: 0.7 };
    if (global.length > 1 && global.length <= 4) return { symbol: lowestId(global), confidence: 0.4 };
  }
  return null;
}

function lowestId(list: SymbolLite[]): SymbolLite {
  return list.reduce((a, b) => (a.id <= b.id ? a : b));
}

/** Big namespaces would flood the imported-file candidate tier — skip them. */
const MODULE_FILE_CAP = 50;

/**
 * C# and Swift imports name a namespace/module, not a file: a `using X`
 * makes every file of X visible, and C# files see their own namespace without
 * any using at all. Adding those files to importedFiles lifts their symbols
 * from the 0.60/0.35 global tiers to the 0.70 imported-file tier.
 */
function augmentModuleVisibility(
  ws: WorkspaceIndex,
  importRows: ImportRow[],
  manifests: Manifests,
): void {
  const idsFor = (paths: string[] | undefined): number[] => {
    if (!paths || paths.length > MODULE_FILE_CAP) return [];
    return paths.map((p) => ws.pathToFileId.get(p)).filter((id): id is number => id !== undefined);
  };
  const addAll = (fileId: number, ids: number[]): void => {
    if (ids.length === 0) return;
    let targets = ws.importedFiles.get(fileId);
    if (!targets) ws.importedFiles.set(fileId, (targets = new Set()));
    for (const id of ids) if (id !== fileId) targets.add(id);
  };

  for (const imp of importRows) {
    if (imp.lang === 'c_sharp') {
      const spec = imp.specifier.replace(/^static\s+/, '').replace(/^\w+\s*=\s*/, '');
      addAll(imp.fileId, idsFor(manifests.csharpNamespaceFiles.get(spec)));
    } else if (imp.lang === 'swift') {
      addAll(imp.fileId, idsFor(manifests.swiftModuleFiles.get(imp.specifier.split('.')[0]!)));
    }
  }

  // C# implicit visibility: files sharing a namespace see each other
  for (const paths of manifests.csharpNamespaceFiles.values()) {
    const ids = idsFor(paths);
    if (ids.length < 2) continue;
    for (const id of ids) addAll(id, ids);
  }
}

/** Innermost symbol containing a position (smallest line span wins). */
function enclosingSymbol(
  ws: WorkspaceIndex,
  fileId: number,
  line: number,
  col: number,
): SymbolLite | null {
  let best: SymbolLite | null = null;
  let bestSpan = Infinity;
  for (const sym of ws.fileSymbols.get(fileId) ?? []) {
    if (sym.startLine > line) break; // sorted by start
    const startsBefore =
      sym.startLine < line || (sym.startLine === line && sym.startCol <= col);
    const endsAfter = sym.endLine > line || (sym.endLine === line && sym.endCol >= col);
    if (!startsBefore || !endsAfter) continue;
    const span = sym.endLine - sym.startLine;
    if (span <= bestSpan) {
      best = sym;
      bestSpan = span;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// import specifier -> file
// ---------------------------------------------------------------------------

/** Everything resolveImportPath needs beyond the specifier — read once per pass. */
interface Manifests {
  goModule: string | null;
  dartPackage: string | null;
  godotRoots: string[];
  /** composer.json psr-4 roots, longest prefix first. */
  composerPsr4: Array<{ prefix: string; dir: string }>;
  /** C# namespace -> declaring file paths (sorted). */
  csharpNamespaceFiles: Map<string, string[]>;
  /** SPM `Sources/<Module>/` (and Tests/) -> member file paths (sorted). */
  swiftModuleFiles: Map<string, string[]>;
}

function readGoModule(rootDir: string): string | null {
  try {
    const text = readFileSync(join(rootDir, 'go.mod'), 'utf8');
    return /^module\s+(\S+)/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** composer.json psr-4 autoload roots (+dev), longest namespace prefix first. */
function readComposerPsr4(rootDir: string): Array<{ prefix: string; dir: string }> {
  try {
    const json = JSON.parse(readFileSync(join(rootDir, 'composer.json'), 'utf8')) as {
      autoload?: { 'psr-4'?: Record<string, string | string[]> };
      'autoload-dev'?: { 'psr-4'?: Record<string, string | string[]> };
    };
    const out: Array<{ prefix: string; dir: string }> = [];
    for (const src of [json.autoload?.['psr-4'], json['autoload-dev']?.['psr-4']]) {
      if (!src) continue;
      for (const [prefix, dirs] of Object.entries(src)) {
        for (const d of Array.isArray(dirs) ? dirs : [dirs]) {
          out.push({ prefix, dir: String(d).replace(/\/+$/, '') });
        }
      }
    }
    return out.sort((a, b) => b.prefix.length - a.prefix.length);
  } catch {
    return [];
  }
}

/** `Sources/<Module>/` and `Tests/<Module>/` subtrees, anywhere in the workspace. */
function swiftModuleDirs(paths: Iterable<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of paths) {
    if (!p.endsWith('.swift')) continue;
    const m = /(?:^|\/)(?:Sources|Tests)\/([^/]+)\//.exec(p);
    if (!m) continue;
    const list = out.get(m[1]!) ?? [];
    list.push(p);
    out.set(m[1]!, list);
  }
  for (const list of out.values()) list.sort();
  return out;
}

/** pubspec.yaml `name:` — makes `package:<self>/...` imports resolvable. */
function readDartPackage(rootDir: string): string | null {
  try {
    const text = readFileSync(join(rootDir, 'pubspec.yaml'), 'utf8');
    return /^name:\s*(\S+)/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

function resolveImport(
  imp: ImportRow,
  pathToFileId: Map<string, number>,
  manifests: Manifests,
): number | null {
  const path = resolveImportPath(imp, pathToFileId, manifests);
  return path === null ? null : (pathToFileId.get(path) ?? null);
}

function resolveImportPath(
  imp: ImportRow,
  pathToFileId: Map<string, number>,
  manifests: Manifests,
): string | null {
  const { goModule, godotRoots, dartPackage } = manifests;
  const has = (p: string): boolean => pathToFileId.has(p);
  const dir = parentDir(imp.path);

  switch (imp.lang) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'vue':
    case 'svelte': {
      const spec = imp.specifier;
      if (!spec.startsWith('.')) return null; // bare specifier: external package
      const base = normalize(joinPosix(dir, spec));
      const candidates: string[] = [];
      // NodeNext style: './x.js' written for a './x.ts' source
      const tsSwap = base.replace(/\.(js|mjs|cjs|jsx)$/, (m) =>
        m === '.mjs' ? '.mts' : m === '.cjs' ? '.cts' : '.ts',
      );
      if (tsSwap !== base) candidates.push(tsSwap, tsSwap.replace(/\.ts$/, '.tsx'));
      candidates.push(base);
      // SFC components import (and are imported) with explicit extensions too
      for (const ext of ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']) {
        candidates.push(base + ext);
      }
      for (const idx of ['/index.ts', '/index.tsx', '/index.js', '/index.jsx']) {
        candidates.push(base + idx);
      }
      return candidates.find(has) ?? null;
    }

    case 'python': {
      const spec = imp.specifier;
      const dots = /^\.*/.exec(spec)![0].length;
      const rest = spec.slice(dots).split('.').filter(Boolean).join('/');
      const bases: string[] = [];
      if (dots > 0) {
        // relative import: one dot = current package, each extra dot = one up
        let rel = dir;
        for (let i = 1; i < dots; i++) rel = parentDir(rel);
        bases.push(rel);
      } else {
        bases.push('', dir); // project root, then importer-relative
      }
      for (const b of bases) {
        const stem = rest.length > 0 ? joinPosix(b, rest) : b;
        for (const cand of [`${stem}.py`, `${stem}/__init__.py`, `${stem}.pyi`]) {
          const n = normalize(cand);
          if (has(n)) return n;
        }
      }
      return null;
    }

    case 'go': {
      const spec = imp.specifier;
      let subdir: string | null = null;
      if (goModule && spec === goModule) subdir = '';
      else if (goModule && spec.startsWith(`${goModule}/`)) subdir = spec.slice(goModule.length + 1);
      else if (!spec.includes('.')) return null; // stdlib
      if (subdir === null) return null;
      // a package is a directory: resolve to its first .go file
      const prefix = subdir === '' ? '' : `${subdir}/`;
      const inDir = [...pathToFileId.keys()]
        .filter((p) => p.startsWith(prefix) && p.endsWith('.go') && !p.slice(prefix.length).includes('/'))
        .sort();
      return inDir[0] ?? null;
    }

    case 'rust': {
      const spec = imp.specifier;
      if (spec.startsWith('./')) {
        // `mod name;` -> sibling file or directory module
        const name = spec.slice(2);
        for (const cand of [
          joinPosix(dir, `${name}.rs`),
          joinPosix(dir, `${name}/mod.rs`),
          // mod decls in main.rs/lib.rs at src root
          `src/${name}.rs`,
          `src/${name}/mod.rs`,
        ]) {
          const n = normalize(cand);
          if (has(n)) return n;
        }
        return null;
      }
      const segs = spec.split('::');
      const head = segs.shift();
      let baseDirs: string[];
      if (head === 'crate') baseDirs = ['src', ''];
      else if (head === 'self') baseDirs = [dir];
      else if (head === 'super') baseDirs = [parentDir(dir)];
      else return null; // external crate
      for (const baseDir of baseDirs) {
        for (let k = segs.length; k >= 1; k--) {
          const stem = joinPosix(baseDir, segs.slice(0, k).join('/'));
          for (const cand of [`${stem}.rs`, `${stem}/mod.rs`]) {
            const n = normalize(cand);
            if (has(n)) return n;
          }
        }
      }
      return null;
    }

    case 'java':
    case 'kotlin': {
      const spec = imp.specifier.replace(/\.\*$/, '');
      const stem = spec.replace(/\./g, '/');
      for (const ext of ['.java', '.kt']) {
        const suffix = stem + ext;
        const matches = [...pathToFileId.keys()].filter((p) => p === suffix || p.endsWith(`/${suffix}`));
        if (matches.length === 1) return matches[0]!;
      }
      return null;
    }

    case 'c':
    case 'cpp': {
      const spec = imp.specifier;
      if (spec.startsWith('<')) return null; // system include
      for (const cand of [joinPosix(dir, spec), spec]) {
        const n = normalize(cand);
        if (has(n)) return n;
      }
      // unique basename match (include paths unknown without compile_commands)
      const base = spec.split('/').pop()!;
      const matches = [...pathToFileId.keys()].filter((p) => p.endsWith(`/${base}`) || p === base);
      return matches.length === 1 ? matches[0]! : null;
    }

    case 'c_sharp': {
      // `using X.Y` -> lexically-first file declaring that namespace; the
      // importedFiles augmentation carries the namespace's remaining files
      const spec = imp.specifier.replace(/^static\s+/, '').replace(/^\w+\s*=\s*/, '');
      return manifests.csharpNamespaceFiles.get(spec)?.[0] ?? null;
    }

    case 'gdscript': {
      // res:// is relative to the importing file's Godot project root — the
      // nearest ancestor holding project.godot — falling back to the
      // workspace root. Scene specifiers map to their sibling script.
      const spec = imp.specifier;
      if (spec.startsWith('res://')) {
        const stem = spec.slice('res://'.length);
        const owningRoot = godotRoots.find((r) => r === '' || imp.path.startsWith(`${r}/`));
        for (const base of owningRoot !== undefined ? [owningRoot, ''] : ['']) {
          const n = normalize(base === '' ? stem : `${base}/${stem}`);
          if (has(n)) return n;
          // scenes/resources aren't in files; map foo.tscn -> sibling foo.gd
          const gd = n.replace(/\.(tscn|tres|scn|res)$/, '.gd');
          if (gd !== n && has(gd)) return gd;
        }
        return null;
      }
      if (spec.startsWith('.')) {
        const n = normalize(joinPosix(dir, spec));
        if (has(n)) return n;
      }
      return null;
    }

    case 'php': {
      // PSR-4: `use App\Service\Mailer` + {"App\\": "src/"} -> src/Service/Mailer.php
      const spec = imp.specifier.replace(/^\\/, '');
      for (const { prefix, dir: base } of manifests.composerPsr4) {
        if (!spec.startsWith(prefix)) continue;
        const rest = spec.slice(prefix.length).replace(/\\/g, '/');
        const n = normalize(base === '' ? `${rest}.php` : `${base}/${rest}.php`);
        if (has(n)) return n;
      }
      return null;
    }

    case 'lua': {
      // require("a.b") -> a/b.lua, a/b/init.lua, plus LuaRocks/Neovim lua/ roots
      const stem = imp.specifier.replace(/\./g, '/');
      for (const cand of [`${stem}.lua`, `${stem}/init.lua`, `lua/${stem}.lua`, `lua/${stem}/init.lua`]) {
        const n = normalize(cand);
        if (has(n)) return n;
      }
      const local = normalize(joinPosix(dir, `${stem}.lua`));
      return has(local) ? local : null;
    }

    case 'solidity': {
      const spec = imp.specifier;
      if (!spec.startsWith('.')) return null; // node_modules / remapped paths
      const n = normalize(joinPosix(dir, spec));
      return has(n) ? n : null;
    }

    case 'zig': {
      const spec = imp.specifier;
      if (!spec.endsWith('.zig')) return null; // std / named packages
      // @import paths are importer-relative, './' prefix optional
      const n = normalize(joinPosix(dir, spec));
      return has(n) ? n : null;
    }

    case 'nix': {
      // path_expression text: ./helpers.nix, ./dir, ../up/x.nix
      const spec = imp.specifier;
      const base = normalize(joinPosix(dir, spec));
      for (const cand of [base, `${base}.nix`, `${base}/default.nix`]) {
        if (has(cand)) return cand;
      }
      return null;
    }

    case 'swift': {
      // SPM layout: `import MyModule` -> Sources/MyModule/ first file; stdlib
      // and system frameworks have no matching directory and fall through
      const module = imp.specifier.split('.')[0]!;
      return manifests.swiftModuleFiles.get(module)?.[0] ?? null;
    }

    case 'terraform': {
      // module source = "./modules/net" -> that directory's main.tf (or any .tf)
      const spec = imp.specifier;
      if (!spec.startsWith('.')) return null; // registry/remote module
      const base = normalize(joinPosix(dir, spec));
      if (has(`${base}/main.tf`)) return `${base}/main.tf`;
      const inDir = [...pathToFileId.keys()]
        .filter((p) => p.startsWith(`${base}/`) && p.endsWith('.tf') && !p.slice(base.length + 1).includes('/'))
        .sort();
      return inDir[0] ?? null;
    }

    case 'pascal': {
      // uses SysUtils, App.Models — case-insensitive basename match
      const stem = imp.specifier.replace(/\./g, '/').toLowerCase();
      const base = stem.split('/').pop()!;
      for (const ext of ['.pas', '.pp']) {
        const matches = [...pathToFileId.keys()].filter((p) => {
          const lower = p.toLowerCase();
          return lower === `${stem}${ext}` || lower.endsWith(`/${stem}${ext}`) || lower.endsWith(`/${base}${ext}`);
        });
        if (matches.length === 1) return matches[0]!;
      }
      return null;
    }

    case 'scala': {
      // like java: package path -> source path; also try dropping the class segment
      const spec = imp.specifier.replace(/\.\*$/, '');
      const segs = spec.split('.');
      for (const stem of [segs.join('/'), segs.slice(0, -1).join('/')]) {
        if (!stem) continue;
        for (const ext of ['.scala', '.sc']) {
          const suffix = stem + ext;
          const matches = [...pathToFileId.keys()].filter((p) => p === suffix || p.endsWith(`/${suffix}`));
          if (matches.length === 1) return matches[0]!;
        }
      }
      return null;
    }

    case 'dart': {
      const spec = imp.specifier;
      if (spec.startsWith('dart:')) return null; // sdk library
      if (spec.startsWith('package:')) {
        const rest = spec.slice('package:'.length);
        const slash = rest.indexOf('/');
        if (slash === -1) return null;
        const pkg = rest.slice(0, slash);
        if (pkg !== dartPackage) return null; // external package
        const n = normalize(`lib/${rest.slice(slash + 1)}`);
        return has(n) ? n : null;
      }
      const n = normalize(joinPosix(dir, spec));
      return has(n) ? n : null;
    }

    case 'ruby': {
      const spec = imp.specifier;
      if (spec.startsWith('./')) {
        // require_relative: sibling path, .rb implied
        const stem = normalize(joinPosix(dir, spec.slice(2)));
        for (const cand of [stem, `${stem}.rb`]) if (has(cand)) return cand;
        return null;
      }
      // require 'foo/bar' — gems are external, but same-repo lib/ layouts resolve
      for (const cand of [`lib/${spec}.rb`, `${spec}.rb`]) {
        const n = normalize(cand);
        if (has(n)) return n;
      }
      return null;
    }

    default:
      return null;
  }
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function joinPosix(a: string, b: string): string {
  if (a === '') return b;
  return `${a}/${b}`;
}

/** Resolve '.' and '..' segments in a root-relative forward-slash path. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}
