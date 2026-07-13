import { describe, expect, it } from 'vitest';
import { extractFile } from '../src/parsing/extractor.js';
import { blankOutsideScript } from '../src/parsing/langs/sfc.js';
import { vueExtractor } from '../src/parsing/langs/vue.js';
import { svelteExtractor } from '../src/parsing/langs/svelte.js';

const VUE_SRC = `<template>
  <div class="card">
    <UserBadge :user="user" />
  </div>
</template>

<script>
export const cardKind = 'wide';
</script>

<script setup lang="ts">
import { ref } from 'vue';
import UserBadge from './UserBadge.vue';

/** The current user. */
const user = ref(null);

function reload(): void {
  user.value = null;
}
</script>

<style scoped>
.card { color: red; }
</style>
`;

const SVELTE_SRC = `<script lang="ts">
  import Widget from './Widget.svelte';

  export let title: string;

  let count = 0;

  function increment(): void {
    count += 1;
  }

  $: doubled = count * 2;
</script>

<h1>{title}</h1>
<button on:click={increment}>{count} / {doubled}</button>

<style>
  h1 { font-weight: bold; }
</style>
`;

describe('blankOutsideScript', () => {
  it('preserves offsets exactly: only non-script chars become spaces', () => {
    const out = blankOutsideScript(VUE_SRC);
    expect(out.length).toBe(VUE_SRC.length);
    expect(out.split('\n').length).toBe(VUE_SRC.split('\n').length);
    expect(out).toContain('export const cardKind');
    expect(out).toContain('function reload');
    expect(out).not.toContain('<template>');
    expect(out).not.toContain('color: red');
    // script content sits at its original index
    const idx = VUE_SRC.indexOf('function reload');
    expect(out.slice(idx, idx + 15)).toBe('function reload');
  });

  it('handles self-closing and src-only script tags', () => {
    const src = `<script src="./ext.js" />\n<script>const a = 1;</script>\n<p>x</p>`;
    const out = blankOutsideScript(src);
    expect(out).toContain('const a = 1;');
    expect(out).not.toContain('<p>');
  });
});

describe('vue extractor', () => {
  it('extracts symbols from both script blocks with file line numbers', async () => {
    const result = await extractFile(vueExtractor, VUE_SRC);
    const byName = new Map(result.symbols.map((s) => [s.name, s]));
    // classic <script> block
    const kind = byName.get('cardKind')!;
    expect(kind.startLine).toBe(8); // real file line, not block-relative
    // <script setup> block
    const user = byName.get('user')!;
    expect(user.docComment).toBe('The current user.');
    expect(user.startLine).toBe(16);
    const reload = byName.get('reload')!;
    expect(reload.kind).toBe('function');
    expect(reload.startLine).toBe(18);
  });

  it('extracts imports including .vue components', async () => {
    const result = await extractFile(vueExtractor, VUE_SRC);
    expect(result.imports).toEqual([
      { specifier: 'vue', names: ['ref'], startLine: 12 },
      { specifier: './UserBadge.vue', names: ['UserBadge'], startLine: 13 },
    ]);
  });
});

describe('svelte extractor', () => {
  it('extracts props, functions, reactive statements as JS', async () => {
    const result = await extractFile(svelteExtractor, SVELTE_SRC);
    const byName = new Map(result.symbols.map((s) => [s.name, s]));
    const inc = byName.get('increment')!;
    expect(inc.kind).toBe('function');
    expect(inc.startLine).toBe(8);
    expect(result.imports).toEqual([
      { specifier: './Widget.svelte', names: ['Widget'], startLine: 2 },
    ]);
  });
});
