// Live integration with the Godot editor's GDScript language server.
//
// Needs a real Godot 4.x binary: set GODOT_BIN, or have `godot`/`godot4` on
// PATH. Without one the suite skips (regular CI); the nightly workflow
// downloads a pinned build and runs it (see .github/workflows/nightly.yml).
// Run locally:  GODOT_BIN=/path/to/godot npx vitest run test/godot-editor.test.ts
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import {
  createMessageConnection,
  SocketMessageReader,
  SocketMessageWriter,
} from 'vscode-jsonrpc/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { Indexer } from '../src/indexer/indexer.js';
import { LspManager } from '../src/lsp/manager.js';
import type { ServerSpec } from '../src/lsp/registry.js';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'godot-sample');
const LSP_PORT = 6010; // off the default 6005 so a developer's open editor is never touched
const BOOT_TIMEOUT_MS = 90_000;

function findGodot(): string | null {
  const candidates = [process.env['GODOT_BIN'], 'godot', 'godot4'].filter(
    (c): c is string => !!c,
  );
  for (const bin of candidates) {
    try {
      if (spawnSync(bin, ['--version'], { timeout: 20_000 }).status === 0) return bin;
    } catch {
      // not this one
    }
  }
  return null;
}

const GODOT = findGodot();

function waitForPort(port: number, deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} never accepted`));
        else setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

let editor: ChildProcess | null = null;

describe.skipIf(!GODOT)('godot editor lsp (live)', () => {
  beforeAll(async () => {
    // first boot of a fresh project must import assets before the LS behaves
    spawnSync(GODOT!, ['--headless', '--import', '--path', FIXTURE_ROOT], { timeout: 60_000 });
    editor = spawn(
      GODOT!,
      ['--headless', '--editor', '--lsp-port', String(LSP_PORT), '--path', FIXTURE_ROOT],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    await waitForPort(LSP_PORT, Date.now() + BOOT_TIMEOUT_MS);
  }, BOOT_TIMEOUT_MS + 70_000);

  afterAll(() => {
    editor?.kill();
    rmSync(join(FIXTURE_ROOT, '.godot'), { recursive: true, force: true });
    rmSync(join(FIXTURE_ROOT, '.code-atlas'), { recursive: true, force: true });
  });

  it('probe: initialize succeeds and reports capabilities', async () => {
    const socket = connect({ host: '127.0.0.1', port: LSP_PORT });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const conn = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
    conn.onNotification(() => {});
    conn.onError(() => {});
    conn.listen();
    try {
      const result = (await conn.sendRequest('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(FIXTURE_ROOT).toString(),
        capabilities: {},
      })) as { capabilities: Record<string, unknown>; serverInfo?: { name?: string } };

      expect(result.capabilities).toBeTruthy();
      // feasibility record: which precise answers this Godot can give us
      const interesting = [
        'definitionProvider', 'hoverProvider', 'referencesProvider',
        'documentSymbolProvider', 'completionProvider', 'renameProvider',
      ] as const;
      const summary = Object.fromEntries(interesting.map((k) => [k, !!result.capabilities[k]]));
      console.log(`godot lsp capabilities (${result.serverInfo?.name ?? 'unnamed'}):`, summary);
      expect(summary.definitionProvider).toBe(true);
      expect(summary.hoverProvider).toBe(true);
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 30_000);

  it('e2e: manager attaches and answers definition/hover on real GDScript', async () => {
    const config = loadConfig(FIXTURE_ROOT);
    const store = new Store(':memory:');
    const indexer = new Indexer(config, store);
    await indexer.run();

    const spec: ServerSpec = {
      id: 'godot-editor-lsp',
      languages: ['gdscript'],
      detectNames: [],
      pathArgs: [],
      languageIds: { gdscript: 'gdscript' },
      installHint: 'open the project in the Godot editor',
      attach: { host: '127.0.0.1', port: LSP_PORT },
    };
    const lsp = new LspManager(FIXTURE_ROOT, { enabled: true, download: false }, [spec]);
    try {
      const client = await lsp.clientFor('gdscript');
      expect(client).not.toBeNull();
      expect(lsp.statusLines().join('\n')).toContain('godot-editor-lsp (gdscript): running');

      // player.gd:12 (1-based) is `take_damage(10)` — its definition is line 14
      const defs = await client!.definition('player.gd', { line: 11, character: 2 });
      expect(defs).not.toBeNull();
      expect(defs!.length).toBeGreaterThan(0);
      expect(defs![0]!.uri).toMatch(/player\.gd$/);
      expect(defs![0]!.range.start.line).toBe(13);

      const hover = await client!.hover('player.gd', { line: 13, character: 7 });
      expect(hover).not.toBeNull();
      expect(JSON.stringify(hover)).toContain('take_damage');
    } finally {
      await lsp.shutdown();
      store.close();
    }
  }, 60_000);
});
