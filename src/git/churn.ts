import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './diff.js';

export interface FileChurn {
  commits: number;
  added: number;
  deleted: number;
}

export type ChurnResult =
  | { ok: true; churn: Map<string, FileChurn>; commits: number; shallow: boolean }
  | { ok: false; reason: string };

const MAX_COMMITS = 1000;

/** Rename numstat paths come as `a/{old => new}/c` or `old => new`; keep the new side. */
export function renamedPath(path: string): string {
  const braced = /\{([^{}]*) => ([^{}]*)\}/;
  if (braced.test(path)) {
    return path.replace(braced, (_, _old: string, next: string) => next).replace(/\/\//g, '/');
  }
  const arrow = / => /;
  return arrow.test(path) ? path.split(' => ')[1]! : path;
}

/** Per-file commit/line churn from one `git log --numstat` pass, fail-soft. */
export async function fileChurn(root: string, since = '90 days'): Promise<ChurnResult> {
  const res = await git(root, [
    'log',
    `--since=${since} ago`,
    `--max-count=${MAX_COMMITS}`,
    '--numstat',
    '--format=%H',
    '--',
    '.',
  ]);
  if (!res.ok) return { ok: false, reason: res.reason };

  const churn = new Map<string, FileChurn>();
  let commits = 0;
  for (const line of res.out.split('\n')) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      commits++;
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const path = renamedPath(m[3]!);
    const entry = churn.get(path) ?? { commits: 0, added: 0, deleted: 0 };
    entry.commits++;
    if (m[1] !== '-') entry.added += Number(m[1]);
    if (m[2] !== '-') entry.deleted += Number(m[2]);
    churn.set(path, entry);
  }
  return { ok: true, churn, commits, shallow: existsSync(join(root, '.git', 'shallow')) };
}
