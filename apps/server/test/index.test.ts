import { readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addUser, sha256 } from '@specforge/core';
import { NotificationLedger, questionAction } from '@specforge/store';
import { ForgeIndex } from '../src/index-db.ts';
import { createIndex, parseIndexConfig } from '../src/index-config.ts';
import { PostgresIndex } from '../src/index-postgres.ts';
import { createApp } from '../src/app.ts';
import { indexContract } from './fixtures/index-contract.ts';
import { indexActor, indexProject, indexQuestion } from './fixtures/index-project.ts';
import { TestPgPool } from './fixtures/pg-transport.ts';

indexContract('SQLite 查询索引契约', async (store) => new ForgeIndex(store));
let transport: TestPgPool | undefined;
indexContract('Postgres 查询索引契约（注入 SQL 传输）', async (store, id) => {
  const index = new PostgresIndex(store, id, transport ??= new TestPgPool());
  await index.initialize();
  return index;
});
afterEach(() => { transport = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('Postgres 故障与配置', () => {
  const roots: string[] = [];
  const indexes: PostgresIndex[] = [];
  const setup = async () => {
    const store = indexProject(); roots.push(store.root);
    const pool = new TestPgPool();
    const index = new PostgresIndex(store, 'a', pool); indexes.push(index);
    await index.initialize(); await index.sync();
    return { store, pool, index };
  };
  afterEach(async () => {
    await Promise.all(indexes.splice(0).map((index) => index.close()));
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it('拒绝连接串配置与缺失环境变量；未配置 Postgres 时仍可使用 SQLite', async () => {
    const store = indexProject(); roots.push(store.root);
    for (const config of [{ backend: 'postgres', connectionString: 'secret' }, { backend: 'postgres', connectionStringEnv: 'postgres://secret' }, { backend: 'sqlite', password: 'secret' }, { backend: 'postgres', connectionStringEnv: 'TEST_DB', projectId: '../bad' }]) expect(() => parseIndexConfig(config)).toThrow();
    vi.stubEnv('SF_INDEX_TEST_MISSING', '');
    await expect(createIndex(store, { indexConfig: { backend: 'postgres', connectionStringEnv: 'SF_INDEX_TEST_MISSING', projectId: 'a' } })).rejects.toThrow(/环境变量未设置/);
    await expect(createIndex(store, { indexConfig: { backend: 'postgres', connectionStringEnv: 'SF_INDEX_TEST_MISSING' } })).rejects.toThrow(/projectId/);
    const index = await createIndex(store, {});
    expect(index.status().backend).toBe('sqlite'); await index.close();
  });

  it('schema 版本不兼容或 ID 换绑时拒绝，不清空旧项目', async () => {
    const { store, pool, index } = await setup();
    pool.db.exec('UPDATE schema_version SET version = 99');
    await expect(index.initialize()).rejects.toMatchObject({ code: 'index_schema' });
    expect(pool.db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 2 });
    pool.db.exec('UPDATE schema_version SET version = 1');
    const other = indexProject(); roots.push(other.root);
    const rebound = new PostgresIndex(other, 'a', { connect: () => pool.connect(), end: async () => {} }); indexes.push(rebound);
    await expect(rebound.initialize()).rejects.toMatchObject({ code: 'index_identity' });
    expect(store.events()).toHaveLength(2);
  });

  it('连接与事务中途失败：503、游标不前移、无密钥输出，恢复后只同步一次', async () => {
    const { store, pool, index } = await setup();
    indexQuestion(store);
    pool.fail = (sql) => sql.startsWith('UPDATE specforge_index.projects');
    const app = createApp(store, index);
    const failed = await app.request('/api/changes');
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toMatch(/secret|private-host/);
    expect(index.status()).toMatchObject({ state: 'stale', lastSyncedSeq: 2 });
    expect(pool.db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 2 });
    const status = await app.request('/api/index');
    expect(status.status).toBe(503);
    expect(await status.json()).toMatchObject({ index: { backend: 'postgres', state: 'stale', lastSyncedSeq: 2 } });
    pool.fail = (sql) => sql === 'CONNECT';
    await expect(index.sync()).rejects.toMatchObject({ code: 'index_unavailable' });
    pool.fail = undefined;
    expect((await index.sync()).events.map((event) => event.seq)).toEqual([3]);
    expect(await index.sync()).toMatchObject({ events: [] });
    expect(store.events()).toHaveLength(3);
    expect((await app.request('/api/changes')).status).toBe(200);
  });

  it('查询失败后拒绝旧列表；rollback 失败时销毁连接', async () => {
    const { pool, index } = await setup();
    pool.fail = (sql) => sql.startsWith('SELECT data');
    await expect(index.changes()).rejects.toMatchObject({ code: 'index_unavailable' });
    await expect(index.events()).rejects.toMatchObject({ code: 'index_unavailable' });
    pool.fail = (sql) => sql.startsWith('UPDATE specforge_index.projects') || sql === 'ROLLBACK';
    await expect(index.sync()).rejects.toMatchObject({ code: 'index_unavailable' });
    expect(pool.destroyed).toBe(1);
  });

  it('成功文件写入后的断库不重放业务请求；恢复只补齐一个事件', async () => {
    const { store, pool, index } = await setup();
    indexQuestion(store);
    store.mutateUsers(indexActor, 'user.added', (registry) => addUser(registry, { name: 'dev', roles: ['dev'], admin: true }, sha256('token'), undefined, 'T'), {});
    await index.sync();
    const app = createApp(store, index);
    expect((await app.request('/api/index')).status).toBe(401);
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'dev', token: 'token' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const original = store.mutate.bind(store);
    vi.spyOn(store, 'mutate').mockImplementation((...args) => {
      const result = original(...args);
      pool.fail = (sql) => sql === 'CONNECT';
      return result;
    });
    const written = await app.request('/api/changes/same/questions/Q-1/answer', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'dev', text: '已确认范围' }) });
    expect(written.status).toBe(200);
    const before = readFileSync(store.path('events.jsonl'), 'utf8');
    expect((await app.request('/api/changes', { headers: { cookie } })).status).toBe(503);
    expect(readFileSync(store.path('events.jsonl'), 'utf8')).toBe(before);
    pool.fail = undefined;
    expect((await index.sync()).events.map((event) => event.type)).toEqual(['question.answered']);
    expect(await index.sync()).toMatchObject({ events: [] });
    expect(readFileSync(store.path('events.jsonl'), 'utf8')).toBe(before);
    expect(store.load('same').questions[0]?.revisions).toHaveLength(1);
  });

  it('异步 SQL 等待期间持有仓库锁；HTTP 等待查询，不把 Promise 当结果', async () => {
    const { store, pool, index } = await setup();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    pool.delay = async () => { entered(); await gate; };
    const response = createApp(store, index).request('/api/events?limit=1');
    await waiting;
    expect(() => indexQuestion(store)).toThrow(/正在执行其他操作/);
    release();
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ events: [{ seq: 1 }] });
    expect(readFileSync(store.path('events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('通知受理记录独立于查询索引：SQLite → Postgres → SQLite 重建不重复排队或改写发送结果', async () => {
    const store = indexProject(); roots.push(store.root);
    store.mutateUsers(indexActor, 'user.added', (registry) => addUser(registry, { name: 'dev', roles: ['dev'], admin: true }, sha256('dev-token'), undefined, 'T'), {});
    store.mutateUsers(indexActor, 'user.added', (registry) => addUser(registry, { name: 'pm', roles: ['product'] }, sha256('pm-token'), indexActor, 'T'), {});
    indexQuestion(store);
    questionAction(store, 'same', indexActor, 'Q-1', { kind: 'answer', text: 'private-answer' });
    const ledger = new NotificationLedger(store, {
      projectId: 'a', enabled: true,
      route: { id: 'team', provider: 'feishu', revision: 'v1', members: [{ name: 'pm', memberId: 'ou_pm' }] },
    });
    const key = ledger.reconcile()[0]!.key;
    ledger.prepare(key); ledger.finish(key, 1, { kind: 'unknown' });
    ledger.retry(key, indexActor, { reason: '已核对并接受重复风险', acceptDuplicateRisk: true });
    ledger.prepare(key); ledger.finish(key, 2, { kind: 'accepted' });
    const records = ledger.list();
    const before = readFileSync(store.path('events.jsonl'), 'utf8');
    const sqlites = [new ForgeIndex(store), new ForgeIndex(store)];
    const pg = new PostgresIndex(store, 'a', new TestPgPool()); indexes.push(pg);
    try {
      await sqlites[0]!.sync({ rebuild: true });
      await pg.initialize(); await pg.sync({ rebuild: true });
      await sqlites[1]!.sync({ rebuild: true });
      for (const index of [sqlites[0]!, pg, sqlites[1]!]) {
        expect((await index.events({ changeId: 'same', limit: 100 })).filter((event) => event.type.startsWith('notification.'))).toHaveLength(6);
        expect(ledger.reconcile()).toEqual(records);
        expect(ledger.prepare(key)).toBeUndefined();
        expect(readFileSync(store.path('events.jsonl'), 'utf8')).toBe(before);
      }
    } finally { await Promise.all(sqlites.map((index) => index.close())); }
  });
});
