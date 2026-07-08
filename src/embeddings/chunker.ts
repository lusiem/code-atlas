import { createHash } from 'node:crypto';
import { computeQualifiedNames } from '../db/store.js';
import type { FileExtraction, SymbolKind } from '../types.js';

/**
 * One embeddable chunk per meaningful symbol. Callables carry their (capped)
 * body; containers carry signature + doc + member names — their bodies would
 * only duplicate the member chunks.
 */
export interface ExtractedChunk {
  /** Index into the extraction's symbols array. */
  symbolIndex: number;
  /** sha1 of content; lets an unchanged symbol keep its vector across reindexes. */
  textHash: string;
  content: string;
}

const LEAF_KINDS = new Set<SymbolKind>([
  'function', 'method', 'constructor', 'signal', 'macro', 'type_alias',
]);
const CONTAINER_KINDS = new Set<SymbolKind>([
  'class', 'interface', 'trait', 'struct', 'enum', 'namespace', 'module', 'impl',
]);

const MAX_DOC_CHARS = 500;
const MAX_BODY_CHARS = 1400;
const MAX_MEMBERS = 40;
const MIN_CONTENT_CHARS = 24;

export function buildChunks(
  extraction: FileExtraction,
  source: string,
  relPath: string,
): ExtractedChunk[] {
  const { symbols } = extraction;
  if (symbols.length === 0) return [];
  const lines = source.split('\n');
  const qualifiedNames = computeQualifiedNames(extraction);

  const childNames = new Map<number, string[]>();
  for (const sym of symbols) {
    if (sym.parentIndex === null) continue;
    let list = childNames.get(sym.parentIndex);
    if (!list) childNames.set(sym.parentIndex, (list = []));
    if (list.length < MAX_MEMBERS) list.push(sym.name);
  }

  const chunks: ExtractedChunk[] = [];
  symbols.forEach((sym, i) => {
    const leaf = LEAF_KINDS.has(sym.kind);
    if (!leaf && !CONTAINER_KINDS.has(sym.kind)) return;

    const parts = [`${relPath}`, `${sym.kind} ${qualifiedNames[i]!}`];
    if (sym.signature && sym.signature !== sym.name) parts.push(sym.signature);
    if (sym.docComment) parts.push(sym.docComment.slice(0, MAX_DOC_CHARS));
    if (leaf) {
      const body = lines
        .slice(sym.startLine - 1, sym.endLine)
        .join('\n')
        .slice(0, MAX_BODY_CHARS);
      if (body) parts.push(body);
    } else {
      const members = childNames.get(i);
      if (members?.length) parts.push(`members: ${members.join(', ')}`);
    }

    const content = parts.join('\n');
    if (content.length < MIN_CONTENT_CHARS) return;
    chunks.push({
      symbolIndex: i,
      textHash: createHash('sha1').update(content).digest('hex'),
      content,
    });
  });
  return chunks;
}
