import { execFile } from 'node:child_process';

/**
 * Minimal git integration for change_impact's no-args mode. Every entry point
 * fails soft: a missing git binary or a non-repo workspace yields
 * `{ ok: false, reason }` and the tool falls back to explicit inputs.
 */

export interface ChangedFile {
  /** Repo-relative path, forward slashes (git's native output form). */
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  /** New-side changed line ranges; absent for untracked/deleted (whole-file). */
  hunks?: Array<{ start: number; count: number }>;
}

export type GitResult =
  | { ok: true; changes: ChangedFile[] }
  | { ok: false; reason: string };

/** Cap on per-file hunk queries so a huge working tree can't stall the tool. */
const HUNK_FILE_CAP = 200;

export function git(root: string, args: string[]): Promise<{ ok: true; out: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, ...args],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') resolve({ ok: false, reason: 'git not found on PATH' });
          else resolve({ ok: false, reason: stderr.trim() || err.message });
        } else {
          resolve({ ok: true, out: stdout });
        }
      },
    );
  });
}

/** Staged + unstaged + untracked changes vs HEAD, with new-side hunk ranges. */
export async function uncommittedChanges(root: string): Promise<GitResult> {
  const inRepo = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inRepo.ok) return { ok: false, reason: `not a git repository (${inRepo.reason})` };

  // one call covers staged and unstaged; -z gives NUL-separated records
  const diff = await git(root, ['diff', 'HEAD', '--name-status', '-z']);
  if (!diff.ok) return diff;
  const changes: ChangedFile[] = [];
  const fields = diff.out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (!status) continue;
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      i += 2; // old path, new path — impact cares about the new one
      const newPath = fields[i];
      if (newPath) changes.push({ path: newPath, status: 'renamed' });
    } else {
      i += 1;
      const path = fields[i];
      if (!path) continue;
      if (kind === 'D') changes.push({ path, status: 'deleted' });
      else if (kind === 'A') changes.push({ path, status: 'added' });
      else changes.push({ path, status: 'modified' });
    }
  }

  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked.ok) {
    for (const path of untracked.out.split('\0')) {
      if (path) changes.push({ path, status: 'untracked' });
    }
  }

  // per-file hunk ranges (new side) for tracked, non-deleted changes
  const wantHunks = changes.filter((c) => c.status !== 'deleted' && c.status !== 'untracked');
  for (const change of wantHunks.slice(0, HUNK_FILE_CAP)) {
    const res = await git(root, ['diff', 'HEAD', '-U0', '--no-color', '--', change.path]);
    if (res.ok) change.hunks = parseHunkRanges(res.out);
  }

  return { ok: true, changes };
}

/** File content at HEAD, or null when it didn't exist there (or git is unavailable). */
export async function showAtHead(root: string, path: string): Promise<string | null> {
  // `:./` makes the path relative to -C's directory even when root is not the repo root
  const res = await git(root, ['show', `HEAD:./${path}`]);
  return res.ok ? res.out : null;
}

/** New-side ranges from `@@ -a,b +c,d @@` headers. Pure-deletion hunks get count 0. */
export function parseHunkRanges(diffText: string): Array<{ start: number; count: number }> {
  const ranges: Array<{ start: number; count: number }> = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diffText)) !== null) {
    ranges.push({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) });
  }
  return ranges;
}
