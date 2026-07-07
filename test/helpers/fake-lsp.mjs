// Minimal fake LSP server for tests: Content-Length framed JSON-RPC over
// stdio, answering from a canned-response file. Relative paths in the canned
// data are resolved against the rootUri received in `initialize`.
// usage: node fake-lsp.mjs <canned.json>
import { readFileSync } from 'node:fs';

const canned = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let rootUri = '';

const resolveUri = (rel) => `${rootUri}/${rel}`;
const resolveItem = (item) => ({ ...item, uri: resolveUri(item.uri) });

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString();
    const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1] ?? 0);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString();
    buffer = buffer.subarray(headerEnd + 4 + length);
    handle(JSON.parse(body));
  }
});

function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function handle(msg) {
  if (msg.id === undefined) {
    if (msg.method === 'exit') process.exit(0);
    return; // notification
  }
  switch (msg.method) {
    case 'initialize':
      rootUri = msg.params.rootUri;
      reply(msg.id, { capabilities: { referencesProvider: true, definitionProvider: true, hoverProvider: true, callHierarchyProvider: true } });
      break;
    case 'textDocument/references':
      reply(msg.id, (canned.references ?? []).map((r) => ({ uri: resolveUri(r.uri), range: r.range })));
      break;
    case 'textDocument/definition':
      reply(msg.id, (canned.definition ?? []).map((r) => ({ uri: resolveUri(r.uri), range: r.range })));
      break;
    case 'textDocument/hover':
      reply(msg.id, canned.hover ?? null);
      break;
    case 'textDocument/prepareCallHierarchy':
      reply(msg.id, canned.hierarchyRoot ? [resolveItem(canned.hierarchyRoot)] : []);
      break;
    case 'callHierarchy/incomingCalls':
      reply(msg.id, (canned.incoming ?? []).map((item) => ({ from: resolveItem(item), fromRanges: [] })));
      break;
    case 'callHierarchy/outgoingCalls':
      reply(msg.id, (canned.outgoing ?? []).map((item) => ({ to: resolveItem(item), fromRanges: [] })));
      break;
    case 'shutdown':
      reply(msg.id, null);
      break;
    default:
      reply(msg.id, null);
  }
}
