import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db/store.js';
import { Indexer } from '../src/indexer/indexer.js';
import { LspManager } from '../src/lsp/manager.js';
import { lspHoverFor, lspReferences } from '../src/lsp/overlay.js';
import type { ServerSpec } from '../src/lsp/registry.js';
import type { SymbolRow } from '../src/types.js';
import { startFakeTcpLsp } from './helpers/fake-tcp-lsp.js';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ts-sample');

const CANNED = {
  references: [
    { uri: 'src/calculator.ts', range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } } },
  ],
  hover: { contents: { kind: 'markdown', value: 'from the editor' } },
};

function attachSpec(port: number): ServerSpec {
  return {
    id: 'fake-editor',
    languages: ['typescript', 'tsx', 'javascript'],
    detectNames: [],
    pathArgs: [],
    languageIds: { typescript: 'typescript' },
    installHint: 'open the editor',
    attach: { host: '127.0.0.1', port },
  };
}

let store: Store;
let ctx: Omit<AppContext, 'lsp'>;

function sym(name: string): SymbolRow {
  const hit = store.searchSymbols(name, { limit: 10, offset: 0 }).find((r) => r.name === name);
  if (!hit) throw new Error(`fixture symbol missing: ${name}`);
  return hit;
}

/** A port that nothing listens on (grabbed from a briefly-bound server). */
async function freePort(): Promise<number> {
  const probe = await startFakeTcpLsp();
  const port = probe.port;
  await probe.close();
  return port;
}

beforeAll(async () => {
  const config = loadConfig(FIXTURE_ROOT);
  store = new Store(':memory:');
  const indexer = new Indexer(config, store);
  await indexer.run();
  ctx = { config, store, indexer };
});

afterAll(() => {
  store?.close();
  rmSync(join(FIXTURE_ROOT, '.code-atlas'), { recursive: true, force: true });
});

describe('lsp over tcp (editor attach)', () => {
  it('attaches to a running server and answers queries', async () => {
    const fake = await startFakeTcpLsp(CANNED);
    const lsp = new LspManager(FIXTURE_ROOT, { enabled: true, download: false }, [attachSpec(fake.port)]);
    try {
      const refs = await lspReferences({ ...ctx, lsp }, sym('add'));
      expect(refs).not.toBeNull();
      expect(refs![0]).toMatchObject({ path: 'src/calculator.ts', line: 1 });
      const hover = await lspHoverFor({ ...ctx, lsp }, sym('add'));
      expect(hover).toContain('from the editor');
      expect(lsp.statusLines().join('\n')).toContain('fake-editor (typescript/tsx/javascript): running');
      expect(fake.received).toContain('initialize');
      expect(fake.received).toContain('textDocument/didOpen');
    } finally {
      await lsp.shutdown();
      await fake.close();
    }
  });

  it('detaches without telling the editor to shut down', async () => {
    const fake = await startFakeTcpLsp(CANNED);
    const lsp = new LspManager(FIXTURE_ROOT, { enabled: true, download: false }, [attachSpec(fake.port)]);
    try {
      expect(await lsp.clientFor('typescript')).not.toBeNull();
      await lsp.shutdown();
      // the server is the editor's, not ours: closing the socket is all we may do
      expect(fake.received).not.toContain('shutdown');
      expect(fake.received).not.toContain('exit');
    } finally {
      await fake.close();
    }
  });

  it('degrades fast when nothing listens, and attaches once the editor appears', async () => {
    const port = await freePort();
    const lsp = new LspManager(FIXTURE_ROOT, { enabled: true, download: false }, [attachSpec(port)]);
    try {
      const t0 = Date.now();
      expect(await lsp.clientFor('typescript')).toBeNull();
      expect(Date.now() - t0).toBeLessThan(3000); // ECONNREFUSED, not a timeout
      expect(lsp.statusLines().join('\n')).toContain('not connected — open the editor');

      // "editor opens" — the same manager must attach on the next query
      const fake = await startFakeTcpLsp(CANNED, port);
      try {
        expect(await lsp.clientFor('typescript')).not.toBeNull();
      } finally {
        await lsp.shutdown();
        await fake.close();
      }
    } catch (err) {
      await lsp.shutdown();
      throw err;
    }
  });

  it('reconnects after the editor drops the connection', async () => {
    const fake = await startFakeTcpLsp(CANNED);
    const lsp = new LspManager(FIXTURE_ROOT, { enabled: true, download: false }, [attachSpec(fake.port)]);
    try {
      const first = await lsp.clientFor('typescript');
      expect(first).not.toBeNull();
      fake.dropConnections();
      await new Promise((r) => setTimeout(r, 50)); // let the close event land
      expect(first!.alive).toBe(false);

      const second = await lsp.clientFor('typescript');
      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
      expect(fake.connections).toBe(2);
      // a normal editor restart never counts toward crash escalation
      expect(lsp.statusLines().join('\n')).not.toContain('crashes');
    } finally {
      await lsp.shutdown();
      await fake.close();
    }
  });
});
