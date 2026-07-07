import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import type { LanguageId } from '../types.js';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  LspHover,
  LspLocation,
  LspLocationLink,
  LspPosition,
} from './protocol.js';

export interface LaunchSpec {
  command: string;
  args: string[];
  initializationOptions?: unknown;
}

const REQUEST_TIMEOUT_MS = 20_000;

interface OpenDoc {
  version: number;
  hash: string;
}

/**
 * One LSP server process speaking JSON-RPC over stdio. Read-only client:
 * we never send edits, only open documents and ask questions.
 */
export class LspClient {
  private constructor(
    private readonly child: ChildProcess,
    private readonly connection: MessageConnection,
    private readonly rootDir: string,
    private readonly languageIds: Partial<Record<LanguageId, string>>,
  ) {}

  private readonly openDocs = new Map<string, OpenDoc>();
  /** Set by the manager to observe unexpected exits. */
  onUnexpectedExit: (() => void) | null = null;
  private disposing = false;

  static async start(
    launch: LaunchSpec,
    rootDir: string,
    languageIds: Partial<Record<LanguageId, string>>,
  ): Promise<LspClient> {
    // .cmd/.bat shims (npm global installs on Windows) need cmd.exe
    const viaCmd = /\.(cmd|bat)$/i.test(launch.command);
    const child = viaCmd
      ? spawn('cmd.exe', ['/c', launch.command, ...launch.args], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr?.on('data', () => {}); // drain; server logs are not ours to spam

    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout!),
      new StreamMessageWriter(child.stdin!),
    );
    // servers push these regardless; ignore quietly
    connection.onNotification(() => {});
    connection.onRequest('workspace/configuration', (params: { items: unknown[] }) =>
      params.items.map(() => null),
    );
    connection.onRequest('window/workDoneProgress/create', () => null);
    connection.onRequest('client/registerCapability', () => null);
    connection.onRequest('workspace/workspaceFolders', () => [
      { uri: pathToFileURL(rootDir).toString(), name: 'workspace' },
    ]);
    connection.listen();

    const client = new LspClient(child, connection, rootDir, languageIds);
    child.on('exit', () => {
      if (!client.disposing) client.onUnexpectedExit?.();
    });

    const rootUri = pathToFileURL(rootDir).toString();
    // settle immediately if the server dies during startup instead of
    // waiting out the initialize timeout
    const exited = new Promise<null>((r) => child.on('exit', () => r(null)));
    const initRequest = client.request('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
      initializationOptions: launch.initializationOptions ?? {},
      capabilities: {
        textDocument: {
          synchronization: { didSave: false },
          references: {},
          definition: { linkSupport: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          callHierarchy: {},
          publishDiagnostics: { relatedInformation: false },
        },
        workspace: { configuration: true, workspaceFolders: true },
        window: { workDoneProgress: true },
      },
    }, 30_000);
    const initResult = await Promise.race([initRequest, exited]);
    if (initResult === null) {
      client.disposing = true;
      connection.dispose();
      child.kill();
      throw new Error('LSP initialize failed or timed out');
    }
    connection.sendNotification('initialized', {});
    return client;
  }

  /** True while the underlying process is alive. */
  get alive(): boolean {
    return this.child.exitCode === null && !this.disposing;
  }

  private request<T>(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T | null> {
    const req = this.connection.sendRequest(method, params) as Promise<T>;
    return Promise.race([
      req.catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs).unref()),
    ]);
  }

  private uriFor(relPath: string): string {
    return pathToFileURL(join(this.rootDir, relPath)).toString();
  }

  /** Open (or refresh) a document so position queries against it are valid. */
  ensureOpen(relPath: string): boolean {
    let text: string;
    try {
      text = readFileSync(join(this.rootDir, relPath), 'utf8');
    } catch {
      return false;
    }
    const hash = createHash('sha1').update(text).digest('hex');
    const known = this.openDocs.get(relPath);
    if (known?.hash === hash) return true;

    const uri = this.uriFor(relPath);
    if (known) {
      this.connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
    }
    const ext = relPath.slice(relPath.lastIndexOf('.'));
    const lang = LANG_BY_EXT[ext];
    const languageId = (lang && this.languageIds[lang]) ?? 'plaintext';
    const version = (known?.version ?? 0) + 1;
    this.connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId, version, text },
    });
    this.openDocs.set(relPath, { version, hash });
    // bound how many documents we keep open in the server
    if (this.openDocs.size > 40) {
      const oldest = this.openDocs.keys().next().value!;
      this.connection.sendNotification('textDocument/didClose', {
        textDocument: { uri: this.uriFor(oldest) },
      });
      this.openDocs.delete(oldest);
    }
    return true;
  }

  /** Drop cached docs for changed files and tell the server the disk changed. */
  filesChanged(relPaths: string[]): void {
    const changes: Array<{ uri: string; type: number }> = [];
    for (const rel of relPaths) {
      changes.push({ uri: this.uriFor(rel), type: 2 /* Changed */ });
      if (this.openDocs.delete(rel)) {
        this.connection.sendNotification('textDocument/didClose', {
          textDocument: { uri: this.uriFor(rel) },
        });
      }
    }
    if (changes.length > 0) {
      this.connection.sendNotification('workspace/didChangeWatchedFiles', { changes });
    }
  }

  references(relPath: string, pos: LspPosition): Promise<LspLocation[] | null> {
    if (!this.ensureOpen(relPath)) return Promise.resolve(null);
    return this.request<LspLocation[]>('textDocument/references', {
      textDocument: { uri: this.uriFor(relPath) },
      position: pos,
      context: { includeDeclaration: false },
    });
  }

  async definition(relPath: string, pos: LspPosition): Promise<LspLocation[] | null> {
    if (!this.ensureOpen(relPath)) return null;
    const res = await this.request<LspLocation | LspLocation[] | LspLocationLink[]>(
      'textDocument/definition',
      { textDocument: { uri: this.uriFor(relPath) }, position: pos },
    );
    if (!res) return null;
    const arr = Array.isArray(res) ? res : [res];
    return arr.map((loc) =>
      'targetUri' in loc
        ? { uri: loc.targetUri, range: loc.targetSelectionRange ?? loc.targetRange }
        : loc,
    );
  }

  hover(relPath: string, pos: LspPosition): Promise<LspHover | null> {
    if (!this.ensureOpen(relPath)) return Promise.resolve(null);
    return this.request<LspHover>('textDocument/hover', {
      textDocument: { uri: this.uriFor(relPath) },
      position: pos,
    });
  }

  async prepareCallHierarchy(relPath: string, pos: LspPosition): Promise<CallHierarchyItem | null> {
    if (!this.ensureOpen(relPath)) return null;
    const items = await this.request<CallHierarchyItem[]>('textDocument/prepareCallHierarchy', {
      textDocument: { uri: this.uriFor(relPath) },
      position: pos,
    });
    return items?.[0] ?? null;
  }

  incomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[] | null> {
    return this.request<CallHierarchyIncomingCall[]>('callHierarchy/incomingCalls', { item });
  }

  outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[] | null> {
    return this.request<CallHierarchyOutgoingCall[]>('callHierarchy/outgoingCalls', { item });
  }

  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    try {
      await Promise.race([
        this.connection.sendRequest('shutdown', undefined),
        new Promise((r) => setTimeout(r, 2000).unref()),
      ]);
      this.connection.sendNotification('exit');
    } catch {
      // already gone
    }
    this.connection.dispose();
    setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill();
    }, 1500).unref();
  }
}

const LANG_BY_EXT: Record<string, LanguageId> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.pyi': 'python',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.cs': 'c_sharp',
};
