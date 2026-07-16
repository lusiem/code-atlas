import type { AppContext } from '../context.js';
import type { EdgeKind, FileExtraction } from '../types.js';
import { showAtHead, uncommittedChanges, type ChangedFile } from '../git/diff.js';
import { extractFile } from '../parsing/extractor.js';
import { extractorFor } from '../parsing/registry.js';
import { languageForPath } from '../languages.js';

/**
 * Post-edit structural check. The baseline is git HEAD, re-extracted on demand —
 * never a snapshot of index state, because the watcher folds edits into the index
 * within its debounce window and any in-index "before" is already gone.
 */

export interface Finding {
  severity: 'BROKEN' | 'CHECK' | 'INFO';
  message: string;
}

export interface VerifyResult {
  summary: string;
  notes: string[];
  findings: Finding[];
}

const CALL_KINDS: EdgeKind[] = ['calls'];
const FILE_CAP = 200;
const MAX_OLD_BLOB = 2 * 1024 * 1024;
const DAMAGE_SITE_CAP = 5;

const SEVERITY_ORDER: Record<Finding['severity'], number> = { BROKEN: 0, CHECK: 1, INFO: 2 };

export async function verifyChanges(
  ctx: AppContext,
  explicitFiles?: string[],
): Promise<VerifyResult | { error: string }> {
  let changes: ChangedFile[];
  if (explicitFiles && explicitFiles.length > 0) {
    changes = explicitFiles.map((path) => ({ path, status: 'modified' as const }));
  } else {
    const res = await uncommittedChanges(ctx.config.root);
    if (!res.ok) {
      return { error: `git mode unavailable: ${res.reason} — pass files=[...] instead` };
    }
    if (res.changes.length === 0) return { error: 'working tree is clean — nothing to verify' };
    changes = res.changes;
  }

  const notes: string[] = [];
  // freshness barrier: queue behind the serialized indexer chain so the resolve
  // pass for these files has finished before we read the index. A concurrent full
  // sweep could make that wait unbounded — warn instead of blocking behind one.
  if (ctx.indexer.progress.state === 'indexing') {
    notes.push('warning: a full sweep is running — results may lag the working tree');
  } else {
    await ctx.indexer.applyChanges(changes.map((c) => c.path));
  }
  if (changes.length > FILE_CAP) {
    notes.push(`analyzing the first ${FILE_CAP} of ${changes.length} changed files`);
    changes = changes.slice(0, FILE_CAP);
  }

  const findings: Finding[] = [];

  const reportRemoved = (name: string, kind: string, excludeFileId: number | null, path: string): void => {
    const elsewhere = ctx.store
      .symbolsByExactName(name)
      .filter((s) => excludeFileId === null || s.fileId !== excludeFileId);
    if (elsewhere.length > 0) {
      findings.push({
        severity: 'INFO',
        message: `${path}: exported ${kind} ${name} removed here, but a definition exists at ${elsewhere[0]!.path}:${elsewhere[0]!.startLine}`,
      });
      return;
    }
    const damage = ctx.store.unresolvedOccurrencesOfName(name, excludeFileId, DAMAGE_SITE_CAP + 1);
    if (damage.length > 0) {
      const shown = damage.slice(0, DAMAGE_SITE_CAP).map((d) => `${d.path}:${d.startLine} (${d.role})`);
      const more = damage.length > DAMAGE_SITE_CAP ? ', …' : '';
      findings.push({
        severity: 'BROKEN',
        message: `${path}: exported ${kind} ${name} was removed and is still referenced — ${shown.join(', ')}${more}`,
      });
    } else {
      findings.push({
        severity: 'INFO',
        message: `${path}: exported ${kind} ${name} removed — no remaining references in the index`,
      });
    }
  };

  for (const change of changes) {
    const file = ctx.store.getFileByPath(change.path);
    const lang = file?.lang ?? languageForPath(change.path)?.id;
    const extractor = lang ? extractorFor(lang) : undefined;

    // old side, re-extracted from the HEAD blob
    let old: FileExtraction | null = null;
    if (extractor && change.status !== 'added' && change.status !== 'untracked') {
      const blob = await showAtHead(ctx.config.root, change.path);
      if (blob !== null && blob.length <= MAX_OLD_BLOB) {
        try {
          old = await extractFile(extractor, blob);
        } catch {
          notes.push(`could not parse the HEAD version of ${change.path} — skipped its baseline checks`);
        }
      }
    }

    if (!file) {
      // deleted (or never-indexed) — only the removed-exports check applies
      if (change.status === 'deleted' && old) {
        for (const oldSym of old.symbols.filter((s) => s.isExported)) {
          reportRemoved(oldSym.name, oldSym.kind, null, change.path);
        }
      }
      continue;
    }

    // 1. imports of this file that no longer resolve. Pre-existing unresolved
    // specifiers (present at HEAD too) are not this change's breakage.
    const oldSpecs = new Set(old?.imports.map((i) => i.specifier) ?? []);
    for (const d of ctx.store.dependenciesOf(file.id)) {
      if (d.resolvedPath !== null) continue;
      const internalish = d.specifier.startsWith('.') || d.specifier.startsWith('res://');
      if (!internalish || oldSpecs.has(d.specifier)) continue;
      findings.push({
        severity: 'BROKEN',
        message: `${change.path}:${d.startLine} import "${d.specifier}" does not resolve to any indexed file`,
      });
    }

    if (!old) continue;
    const currentSymbols = ctx.store.symbolsForFile(file.id);
    const currentByName = new Map(currentSymbols.map((s) => [s.name, s]));

    // 2. exported symbols that vanished, with the references they strand
    for (const oldSym of old.symbols.filter((s) => s.isExported)) {
      if (currentByName.has(oldSym.name)) continue;
      reportRemoved(oldSym.name, oldSym.kind, file.id, change.path);
    }

    // 3. signature changes on symbols that still have callers
    for (const oldSym of old.symbols) {
      const cur = currentByName.get(oldSym.name);
      if (!cur || !oldSym.signature || !cur.signature || oldSym.signature === cur.signature) continue;
      const callers = ctx.store.edgesFor(cur.id, 'in', CALL_KINDS);
      if (callers.length === 0) continue;
      const shown = callers.slice(0, 3).map((c) => `${c.qualifiedName} (${c.path}:${c.startLine})`);
      const more = callers.length > 3 ? `, +${callers.length - 3} more` : '';
      findings.push({
        severity: 'CHECK',
        message:
          `${change.path}: signature of ${cur.kind} ${cur.name} changed\n` +
          `  old: ${oldSym.signature}\n  new: ${cur.signature}\n` +
          `  callers: ${shown.join(', ')}${more}`,
      });
    }
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts = { BROKEN: 0, CHECK: 0, INFO: 0 };
  for (const f of findings) counts[f.severity]++;
  return {
    summary:
      `verified ${changes.length} changed file(s) against HEAD: ` +
      `${counts.BROKEN} broken, ${counts.CHECK} to check, ${counts.INFO} informational`,
    notes,
    findings,
  };
}
