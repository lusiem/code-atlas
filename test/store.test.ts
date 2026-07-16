import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db/store.js';
import type { FileExtraction } from '../src/types.js';

function sampleExtraction(): FileExtraction {
  return {
    symbols: [
      {
        name: 'UserService',
        kind: 'class',
        startLine: 3, startCol: 0, endLine: 20, endCol: 1,
        signature: 'class UserService',
        docComment: 'Manages users.',
        parentIndex: null,
        isExported: true,
        bases: [{ name: 'BaseService', kind: 'extends' as const }],
      },
      {
        name: 'findUser',
        kind: 'method',
        startLine: 5, startCol: 2, endLine: 9, endCol: 3,
        signature: 'findUser(id: string): User',
        docComment: null,
        parentIndex: 0,
        isExported: true,
        bases: [],
      },
      {
        name: 'cache',
        kind: 'field',
        startLine: 4, startCol: 2, endLine: 4, endCol: 20,
        signature: null,
        docComment: null,
        parentIndex: 0,
        isExported: false,
        bases: [],
      },
    ],
    imports: [{ specifier: './db', names: ['db'], startLine: 1 }],
    occurrences: [],
  };
}

describe('Store', () => {
  let store: Store;
  afterEach(() => store?.close());

  const meta = { path: 'src/user.ts', lang: 'typescript' as const, hash: 'h1', size: 100, mtimeMs: 1, isTest: false };

  it('replaceFile inserts symbols with qualified names and parents', () => {
    store = new Store(':memory:');
    store.replaceFile(meta, sampleExtraction());

    const file = store.getFileByPath('src/user.ts')!;
    const symbols = store.symbolsForFile(file.id);
    expect(symbols).toHaveLength(3);

    const method = symbols.find((s) => s.name === 'findUser')!;
    expect(method.qualifiedName).toBe('UserService.findUser');
    const parent = store.getSymbolById(method.parentSymbolId!)!;
    expect(parent.name).toBe('UserService');
  });

  it('searchSymbols finds by FTS prefix and respects filters', () => {
    store = new Store(':memory:');
    store.replaceFile(meta, sampleExtraction());

    const hits = store.searchSymbols('findU', { limit: 10, offset: 0 });
    expect(hits.map((h) => h.name)).toContain('findUser');

    const classOnly = store.searchSymbols('user', { kind: 'class', limit: 10, offset: 0 });
    expect(classOnly).toHaveLength(1);
    expect(classOnly[0]!.name).toBe('UserService');

    const exported = store.searchSymbols('cache', { exportedOnly: true, limit: 10, offset: 0 });
    expect(exported).toHaveLength(0);
  });

  it('searchSymbols falls back to substring matching', () => {
    store = new Store(':memory:');
    store.replaceFile(meta, sampleExtraction());
    // 'indUse' is not a token prefix; only LIKE finds it
    const hits = store.searchSymbols('indUse', { limit: 10, offset: 0 });
    expect(hits.map((h) => h.name)).toContain('findUser');
  });

  it('replaceFile is idempotent and cleans up FTS rows', () => {
    store = new Store(':memory:');
    store.replaceFile(meta, sampleExtraction());
    store.replaceFile({ ...meta, hash: 'h2' }, sampleExtraction());

    expect(store.stats().symbols).toBe(3);
    const hits = store.searchSymbols('findUser', { limit: 10, offset: 0 });
    expect(hits).toHaveLength(1);
  });

  it('removeFile drops all traces', () => {
    store = new Store(':memory:');
    store.replaceFile(meta, sampleExtraction());
    store.removeFile('src/user.ts');
    expect(store.stats()).toEqual({ files: 0, symbols: 0, imports: 0, occurrences: 0, edges: 0 });
    expect(store.searchSymbols('findUser', { limit: 10, offset: 0 })).toHaveLength(0);
  });

  it('symbolAt returns the innermost enclosing symbol', () => {
    store = new Store(':memory:');
    store.replaceFile(meta, sampleExtraction());
    const file = store.getFileByPath('src/user.ts')!;
    expect(store.symbolAt(file.id, 6, 4)!.name).toBe('findUser');
    expect(store.symbolAt(file.id, 15, 0)!.name).toBe('UserService');
    expect(store.symbolAt(file.id, 99, 0)).toBeUndefined();
  });
});

describe('knnChunks vec0 cache', () => {
  const meta = { path: 'src/user.ts', lang: 'typescript' as const, hash: 'h1', size: 100, mtimeMs: 1, isTest: false };
  const chunks = [
    { symbolIndex: 0, textHash: 't1', content: 'class UserService manages users' },
    { symbolIndex: 1, textHash: 't2', content: 'findUser looks a user up by id' },
  ];
  const dims = 8;
  const vec = (values: number[]): Float32Array => {
    const v = new Float32Array(dims);
    values.forEach((x, i) => (v[i] = x));
    return v;
  };

  it('ranks identically to the exact scan and mirrors deletes', () => {
    const store = new Store(':memory:');
    store.replaceFile(meta, sampleExtraction(), chunks);
    const pending = store.pendingChunks(10);
    expect(pending).toHaveLength(2);
    store.writeChunkVectors([
      { chunkId: pending[0]!.id, vector: vec([1, 0]) },
      { chunkId: pending[1]!.id, vector: vec([0.6, 0.8]) },
    ]);

    const hits = store.knnChunks(vec([1, 0]), 2);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.chunkId).toBe(pending[0]!.id);
    expect(hits[0]!.score).toBeCloseTo(1, 3);
    expect(hits[1]!.chunkId).toBe(pending[1]!.id);
    expect(hits[1]!.score).toBeCloseTo(0.6, 3);

    if (store.vecAccel) {
      const count = () =>
        (store.db.prepare('SELECT COUNT(*) AS n FROM chunk_vec_idx').get() as { n: number }).n;
      expect(count()).toBe(2);
      store.removeFile(meta.path);
      expect(count()).toBe(0);
    }
    store.close();
  });

  it('lang filter stays correct through the overfetch path', () => {
    const store = new Store(':memory:');
    store.replaceFile(meta, sampleExtraction(), chunks);
    store.replaceFile(
      { ...meta, path: 'src/other.py', lang: 'python' as const, hash: 'h2' },
      sampleExtraction(),
      [{ symbolIndex: 0, textHash: 't3', content: 'python service' }],
    );
    const pending = store.pendingChunks(10);
    store.writeChunkVectors(
      pending.map((c, i) => ({ chunkId: c.id, vector: vec([1 - i * 0.1, i * 0.1]) })),
    );
    const hits = store.knnChunks(vec([1, 0]), 5, 'python');
    expect(hits.length).toBe(1); // only the python chunk qualifies
    store.close();
  });
});
