/**
 * Single-file-component handling: replace every character outside
 * <script>...</script> bodies with spaces (newlines kept), leaving a valid
 * JS/TS module at its true file offsets — the exact contract the extractor's
 * `preprocess` hook requires. Multiple blocks (Vue's <script setup> +
 * <script>) all survive; <script src="..."> has an empty body and contributes
 * nothing. The scanner is lexical: a literal "</script>" inside a template
 * string would end the block early — acceptable for real-world components.
 */
export function blankOutsideScript(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
    }
  };
  let pos = 0;
  let lastBodyEnd = 0;
  const lower = source.toLowerCase();
  while (pos < source.length) {
    const open = lower.indexOf('<script', pos);
    if (open === -1) break;
    const tagEnd = source.indexOf('>', open);
    if (tagEnd === -1) break;
    if (source[tagEnd - 1] === '/') {
      // self-closing <script src="..." /> — no body
      pos = tagEnd + 1;
      continue;
    }
    const close = lower.indexOf('</script', tagEnd);
    if (close === -1) break;
    blank(lastBodyEnd, tagEnd + 1);
    lastBodyEnd = close;
    pos = close + 1;
  }
  blank(lastBodyEnd, source.length);
  return out.join('');
}
