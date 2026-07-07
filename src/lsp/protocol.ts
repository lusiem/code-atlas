/**
 * Minimal hand-rolled LSP shapes — only what we consume. Positions here are
 * LSP convention (0-based line and character); the index is 1-based lines.
 */

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
}

export interface LspHover {
  contents:
    | string
    | { kind?: string; value: string }
    | Array<string | { language?: string; value: string }>;
}

export interface CallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
  detail?: string;
}

export interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: LspRange[];
}

export interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: LspRange[];
}

/** LSP SymbolKind number -> our vocabulary (approximate, for display). */
export function symbolKindName(kind: number): string {
  const names: Record<number, string> = {
    1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class', 6: 'method',
    7: 'property', 8: 'field', 9: 'constructor', 10: 'enum', 11: 'interface',
    12: 'function', 13: 'variable', 14: 'constant', 15: 'string', 16: 'number',
    17: 'boolean', 18: 'array', 19: 'object', 20: 'key', 21: 'null',
    22: 'enum_member', 23: 'struct', 24: 'event', 25: 'operator', 26: 'type_parameter',
  };
  return names[kind] ?? 'symbol';
}

export function hoverText(hover: LspHover | null): string | null {
  if (!hover) return null;
  const c = hover.contents;
  const one = (x: string | { value: string }): string => (typeof x === 'string' ? x : x.value);
  const text = Array.isArray(c) ? c.map(one).join('\n\n') : one(c);
  return text.trim() || null;
}
