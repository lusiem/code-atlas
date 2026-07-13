import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { Indexer } from '../src/indexer/indexer.js';
import { createServer } from '../src/server.js';
import { frameworkForFile } from '../src/frameworks/detect.js';
import { extractRoutes } from '../src/frameworks/registry.js';
import { routePattern } from '../src/tools/frameworks.js';

// ---------- detection ----------

describe('frameworkForFile', () => {
  const imp = (specifier: string) => [{ specifier, names: [], startLine: 1 }];
  it('maps import specifiers to frameworks', () => {
    expect(frameworkForFile('typescript', 'src/a.ts', imp('express'))).toBe('express');
    expect(frameworkForFile('typescript', 'src/a.ts', imp('fastify'))).toBe('fastify');
    expect(frameworkForFile('typescript', 'src/a.ts', imp('@nestjs/common'))).toBe('nestjs');
    expect(frameworkForFile('python', 'app/main.py', imp('fastapi'))).toBe('fastapi');
    expect(frameworkForFile('python', 'app/views.py', imp('flask'))).toBe('flask');
    expect(frameworkForFile('python', 'app/urls.py', imp('django.urls'))).toBe('django');
  });
  it('nestjs wins over its express adapter', () => {
    const imports = [...imp('@nestjs/common'), ...imp('express')];
    expect(frameworkForFile('typescript', 'src/a.ts', imports)).toBe('nestjs');
  });
  it('urls.py alone is django', () => {
    expect(frameworkForFile('python', 'proj/urls.py', [])).toBe('django');
  });
  it('unrelated files are not frameworks', () => {
    expect(frameworkForFile('typescript', 'src/a.ts', imp('lodash'))).toBeNull();
    expect(frameworkForFile('python', 'src/a.py', imp('os'))).toBeNull();
  });
});

// ---------- extraction goldens ----------

const EXPRESS_SRC = `import express from 'express';
import { listUsers } from './users.js';
const app = express();
app.get('/users', listUsers);
app.post('/users', (req, res) => res.send('ok'));
app.use('/api', apiRouter);
const cache = new Map();
cache.get('key');
`;

const NEST_SRC = `import { Controller, Get, Post } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get(':id')
  findOne(id: string) { return id; }

  @Post()
  create() { return null; }
}
`;

const FASTAPI_SRC = `from fastapi import APIRouter

router = APIRouter(prefix="/items")

@router.get("/{item_id}")
def read_item(item_id: int):
    return item_id

@router.websocket("/ws")
async def item_feed(ws):
    pass
`;

const FLASK_SRC = `from flask import Blueprint

bp = Blueprint('admin', __name__, url_prefix='/admin')

@bp.route('/users', methods=['GET', 'POST'])
def users():
    return 'ok'

@bp.get('/health')
def health():
    return 'up'
`;

const DJANGO_SRC = `from django.urls import path, include
from . import views

urlpatterns = [
    path('users/<int:pk>/', views.detail),
    path('posts/', PostList.as_view()),
    path('api/', include('api.urls')),
]
`;

describe('route extraction', () => {
  it('express: verb calls with string paths; Map.get is not a route', async () => {
    const routes = await extractRoutes('express', 'typescript', EXPRESS_SRC);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /users',
      'POST /users',
      'USE /api',
    ]);
    expect(routes[0]!.handlerName).toBe('listUsers');
    expect(routes[1]!.handlerName).toBeNull(); // inline arrow
    expect(routes[2]!.detail).toContain('apiRouter');
  });

  it('nestjs: controller prefix joins method decorators', async () => {
    const routes = await extractRoutes('nestjs', 'typescript', NEST_SRC);
    expect(routes.map((r) => `${r.method} ${r.fullPath}`)).toEqual([
      'GET /users/:id',
      'POST /users',
    ]);
    expect(routes[0]!.handlerName).toBe('findOne');
    expect(routes[0]!.handlerLine).toBe(6);
  });

  it('fastapi: router prefix + websocket', async () => {
    const routes = await extractRoutes('fastapi', 'python', FASTAPI_SRC);
    expect(routes.map((r) => `${r.method} ${r.fullPath}`)).toEqual([
      'GET /items/{item_id}',
      'WS /items/ws',
    ]);
    expect(routes[0]!.handlerName).toBe('read_item');
  });

  it('flask: methods kwarg fans out; blueprint url_prefix joins', async () => {
    const routes = await extractRoutes('flask', 'python', FLASK_SRC);
    expect(routes.map((r) => `${r.method} ${r.fullPath}`)).toEqual([
      'GET /admin/users',
      'POST /admin/users',
      'GET /admin/health',
    ]);
  });

  it('django: dotted views, as_view classes, include noted', async () => {
    const routes = await extractRoutes('django', 'python', DJANGO_SRC);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'ANY users/<int:pk>/',
      'ANY posts/',
      'ANY api/',
    ]);
    expect(routes[0]!.handlerName).toBe('views.detail');
    expect(routes[1]!.handlerName).toBe('PostList');
    expect(routes[2]!.detail).toContain('api.urls');
  });
});

describe('routePattern', () => {
  it('parameter segments match concrete values', () => {
    expect(routePattern('/users/:id').test('/users/7')).toBe(true);
    expect(routePattern('/items/{item_id}').test('/items/42')).toBe(true);
    expect(routePattern('users/<int:pk>/').test('/users/9')).toBe(true);
    expect(routePattern('/users/:id').test('/users/7/posts')).toBe(false);
    expect(routePattern('/users').test('/users/')).toBe(true);
  });
});

// ---------- end-to-end through the indexer and MCP tools ----------

let root: string;
let store: Store;
let client: Client;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'atlas-fw-'));
  mkdirSync(join(root, 'api'));
  writeFileSync(join(root, 'api', 'server.ts'), EXPRESS_SRC);
  writeFileSync(
    join(root, 'api', 'users.ts'),
    `export function listUsers(req: unknown, res: unknown): void {}\n`,
  );
  writeFileSync(join(root, 'api', 'items.py'), FASTAPI_SRC);

  const config = loadConfig(root);
  store = new Store(':memory:');
  const indexer = new Indexer(config, store);
  await indexer.run();

  const server = createServer({ config, store, indexer });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
});

afterAll(() => {
  store?.close();
  rmSync(root, { recursive: true, force: true });
});

async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((c) => c.text).join('\n');
}

describe('framework tools end-to-end', () => {
  it('project_overview reports frameworks', async () => {
    const text = await callText('project_overview');
    expect(text).toContain('frameworks:');
    expect(text).toContain('express: 3 routes');
    expect(text).toContain('fastapi: 2 routes');
  });

  it('list_routes shows resolved handlers', async () => {
    const text = await callText('list_routes', { framework: 'express' });
    expect(text).toContain('GET    /users');
    // named handler resolved cross-file by the resolver pass
    expect(text).toContain('function listUsers');
    expect(text).toContain('api/users.ts');
  });

  it('list_routes filters by method', async () => {
    const text = await callText('list_routes', { method: 'POST' });
    expect(text).toContain('POST');
    expect(text).not.toContain('WS ');
  });

  it('find_route matches parameter segments', async () => {
    const text = await callText('find_route', { url: 'GET /items/42' });
    expect(text).toContain('/items/{item_id}');
    expect(text).toContain('read_item');
  });

  it('find_route with no match explains itself', async () => {
    const text = await callText('find_route', { url: '/nope/xyz' });
    expect(text).toContain('no route matches');
  });

  it('reindexing a route file replaces its routes (no duplicates)', async () => {
    writeFileSync(join(root, 'api', 'items.py'), FASTAPI_SRC.replace('/ws', '/feed'));
    // direct indexer access: re-run the sweep
    const config = loadConfig(root);
    const indexer = new Indexer(config, store);
    await indexer.run();
    const stats = store.routeStats();
    expect(stats.find((s) => s.framework === 'fastapi')?.n).toBe(2);
    const text = await callText('list_routes', { framework: 'fastapi' });
    expect(text).toContain('/items/feed');
    expect(text).not.toContain('/items/ws');
  });
});
