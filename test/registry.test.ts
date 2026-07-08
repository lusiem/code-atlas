import { describe, expect, it } from 'vitest';
import { REGISTRY, specForLanguage } from '../src/lsp/registry.js';

describe('lsp registry (wave 2)', () => {
  it('covers every LSP-capable language exactly once', () => {
    const langs = REGISTRY.flatMap((s) => s.languages);
    expect(new Set(langs).size).toBe(langs.length); // no double ownership
    for (const lang of ['java', 'kotlin', 'c_sharp', 'rust', 'c', 'cpp'] as const) {
      expect(specForLanguage(lang), lang).toBeDefined();
    }
  });

  it('pins a well-formed sha256 on every binary/jdtls asset', () => {
    for (const spec of REGISTRY) {
      if (spec.acquire?.kind === 'binary') {
        const assets = Object.values(spec.acquire.assets);
        expect(assets.length, spec.id).toBeGreaterThan(0);
        for (const a of assets) {
          expect(a.sha256, `${spec.id} ${a.url}`).toMatch(/^[0-9a-f]{64}$/);
          expect(a.url).toMatch(/^https:\/\//);
        }
      } else if (spec.acquire?.kind === 'jdtls') {
        expect(spec.acquire.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('binary launch paths use windows overrides where the bin is not an .exe archive root', () => {
    const clangd = REGISTRY.find((s) => s.id === 'clangd')!;
    if (clangd.acquire?.kind === 'binary') {
      expect(clangd.acquire.assets['win32-x64']!.binWin).toContain('clangd.exe');
    }
    const kls = REGISTRY.find((s) => s.id === 'kotlin-language-server')!;
    if (kls.acquire?.kind === 'binary') {
      expect(kls.acquire.assets.any!.binWin).toContain('.bat');
      expect(kls.acquire.requires).toBe('java');
    }
  });
});
