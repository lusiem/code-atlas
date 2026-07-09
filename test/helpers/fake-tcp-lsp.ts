// In-process fake of the Godot editor's LSP endpoint: Content-Length framed
// JSON-RPC over TCP, answering from canned data. Relative paths in the canned
// data are resolved against the rootUri received in `initialize`.
import { createServer, type Server, type Socket } from 'node:net';

type Json = Record<string, unknown>;

export interface FakeTcpLsp {
  port: number;
  /** Every request/notification method received, in order, across connections. */
  received: string[];
  connections: number;
  /** Hard-close all live sockets (editor quit / crashed). */
  dropConnections(): void;
  close(): Promise<void>;
}

export function startFakeTcpLsp(canned: Json = {}, port = 0): Promise<FakeTcpLsp> {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  let rootUri = '';
  let connections = 0;

  const resolveUri = (rel: string) => `${rootUri}/${rel}`;

  const handle = (socket: Socket, msg: { id?: number; method?: string; params?: Json }) => {
    if (msg.method) received.push(msg.method);
    if (msg.id === undefined) return; // notification
    const reply = (result: unknown) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };
    switch (msg.method) {
      case 'initialize':
        rootUri = (msg.params as { rootUri: string }).rootUri;
        reply({
          capabilities: { referencesProvider: true, definitionProvider: true, hoverProvider: true },
          serverInfo: { name: 'fake-godot-lsp' },
        });
        break;
      case 'textDocument/references':
        reply(
          ((canned['references'] as Array<{ uri: string; range: unknown }>) ?? []).map((r) => ({
            uri: resolveUri(r.uri),
            range: r.range,
          })),
        );
        break;
      case 'textDocument/definition':
        reply(
          ((canned['definition'] as Array<{ uri: string; range: unknown }>) ?? []).map((r) => ({
            uri: resolveUri(r.uri),
            range: r.range,
          })),
        );
        break;
      case 'textDocument/hover':
        reply(canned['hover'] ?? null);
        break;
      default:
        reply(null);
    }
  };

  const server: Server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1] ?? 0);
        if (buffer.length < headerEnd + 4 + length) return;
        const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString();
        buffer = buffer.subarray(headerEnd + 4 + length);
        handle(socket, JSON.parse(body));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        get port() {
          return (server.address() as { port: number }).port;
        },
        received,
        get connections() {
          return connections;
        },
        dropConnections() {
          for (const s of sockets) s.destroy();
        },
        close() {
          for (const s of sockets) s.destroy();
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}
