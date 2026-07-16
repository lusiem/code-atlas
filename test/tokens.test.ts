import { describe, expect, it } from 'vitest';
import { clampText, clampToBudget, estimateTokens } from '../src/tools/tokens.js';

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates roughly chars/3.7', () => {
    expect(estimateTokens('abcd')).toBe(2); // ceil(4 / 3.7)
    expect(estimateTokens('a'.repeat(37))).toBe(10);
  });

  it('collapses whitespace runs before counting', () => {
    expect(estimateTokens('a        b')).toBe(estimateTokens('a b'));
    expect(estimateTokens('a\n\n\t  b')).toBe(estimateTokens('a b'));
  });
});

describe('clampToBudget', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i} with some padding text here`);

  it('keeps everything when the budget covers it', () => {
    const { text, omittedLines } = clampToBudget(['a', 'b'], 1000);
    expect(text).toBe('a\nb');
    expect(omittedLines).toBe(0);
  });

  it('cuts whole lines once the budget is spent', () => {
    const { text, omittedLines } = clampToBudget(lines, 50);
    expect(omittedLines).toBeGreaterThan(0);
    expect(omittedLines).toBeLessThan(100);
    const kept = text.split('\n');
    expect(kept[0]).toBe(lines[0]);
    expect(kept[kept.length - 1]).toBe(lines[kept.length - 1]); // prefix, in order
  });

  it('always keeps at least one line, even over budget', () => {
    const huge = 'x'.repeat(10_000);
    const { text, omittedLines } = clampToBudget([huge, 'second'], 10);
    expect(text).toBe(huge);
    expect(omittedLines).toBe(1);
  });
});

describe('clampText', () => {
  it('returns the input unchanged when under budget', () => {
    expect(clampText('short answer', 1000)).toBe('short answer');
  });

  it('appends the truncation footer when cut', () => {
    const body = Array.from({ length: 200 }, (_, i) => `row ${i} …………………………`).join('\n');
    const out = clampText(body, 200);
    expect(out).toContain('… truncated at ~200 tokens');
    expect(out).toContain('raise max_tokens');
    expect(estimateTokens(out)).toBeLessThan(300); // footer overhead stays small
  });
});
