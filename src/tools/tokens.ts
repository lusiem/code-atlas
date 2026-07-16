import { z } from 'zod';

/**
 * Rough token estimate for tool output: ~3.7 chars per token after collapsing
 * whitespace runs. Intentionally a heuristic — the real tokenizer varies by model,
 * and pulling one in would add a heavy dependency for what is only a budget guard.
 */
export function estimateTokens(s: string): number {
  if (s.length === 0) return 0;
  return Math.ceil(s.replace(/\s+/g, ' ').length / 3.7);
}

/** Shared `max_tokens` input fragment for list-shaped tools. */
export const maxTokensArg = {
  max_tokens: z.number().int().min(200).max(20000).default(2500)
    .describe('soft cap on response size in estimated tokens; truncated output says how to get the rest'),
};

/**
 * Keeps whole lines until the budget is spent. Always keeps at least one line so a
 * tiny budget still returns an answer instead of only a truncation notice.
 */
export function clampToBudget(
  lines: string[],
  maxTokens: number,
): { text: string; omittedLines: number } {
  let spent = 0;
  let kept = 0;
  for (const line of lines) {
    const cost = estimateTokens(line) + 1; // +1 for the newline join
    if (kept > 0 && spent + cost > maxTokens) break;
    spent += cost;
    kept++;
  }
  return { text: lines.slice(0, kept).join('\n'), omittedLines: lines.length - kept };
}

/** Clamp an assembled response body, appending a standard truncation footer when cut. */
export function clampText(s: string, maxTokens: number): string {
  const { text, omittedLines } = clampToBudget(s.split('\n'), maxTokens);
  if (omittedLines === 0) return s;
  return `${text}\n… truncated at ~${maxTokens} tokens (${omittedLines} more lines) — raise max_tokens or narrow the query`;
}
