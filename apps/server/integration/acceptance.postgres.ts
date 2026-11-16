import { randomUUID } from 'node:crypto';
import { once, type EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect, createServer, type AddressInfo, type Socket as TcpSocket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { addUser, sha256 } from '@specforge/core';
import { headSha, readLogAnchors } from '@specforge/runner';
import { anchorLog, type Store } from '@specforge/store';
import { startMultiProjectServer, startServer, type RunningMultiProjectServer } from '../src/server.ts';
import { PostgresIndex } from '../src/index-postgres.ts';
import { sourceFiles } from '../test/fixtures/index-contract.ts';
import { indexActor, indexProject, indexQuestion } from '../test/fixtures/index-project.ts';

// 只在单独的显式命令中运行。故障测试创建自己的空数据库与角色，不修改传入库的 schema。
const adminUrl = process.env.SF_POSTGRES_TEST_URL;
if (!adminUrl) throw new Error('请先授权专用测试服务，并设置 SF_POSTGRES_TEST_URL（需 CREATEDB / CREATEROLE）');
const suffix = randomUUID().replaceAll('-', '');
const database = `sf_accept_${suffix}`;
const role = `sf_limited_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
const url = new URL(adminUrl);
url.pathname = `/${database}`;
const connectionString = url.href;
const password = randomUUID();
const limitedUrl = new URL(connectionString);
limitedUrl.username = role;
limitedUrl.password = password;
const environment = `SF_ACCEPT_${suffix}`;
let pool: Pool;
let databaseCreated = false;
let roleCreated = false;
const roots: string[] = [];
const servers: RunningMultiProjectServer[] = [];
const indexes: PostgresIndex[] = [];
const sockets: { close(): void }[] = [];
const proxies: { close(): Promise<void> }[] = [];
const Socket = createRequire(import.meta.url)('ws') as new (url: string, options: { headers: { cookie: string } }) => EventEmitter & { close(): void };

beforeAll(async () => {
  // 所有标识符和密码均由本测试生成，不来自用户输入。
  await admin.query(`CREATE DATABASE "${database}"`);
  databaseCreated = true;
  await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
  roleCreated = true;
  pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  process.env[environment] = connectionString;
}, 30_000);

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(indexes.splice(0).map((index) => index.close()));
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  process.env[environment] = connectionString;
});

afterAll(async () => {
  delete process.env[environment];
  await pool?.end();
  try {
    if (databaseCreated) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
  } finally { await admin.end(); }
}, 30_000);

function project(label: string): Store {
  const store = indexProject(label);
  roots.push(store.root);
  indexQuestion(store);
  store.mutateUsers(indexActor, 'user.added', (registry) => addUser(registry, { name: 'dev', roles: ['dev', 'product'], admin: true }, sha256(`token-${label}`), undefined, 'T'), {});
  return store;
}

function config() { return { backend: 'postgres' as const, connectionStringEnv: environment }; }
async function multi(a: Store, b: Store, prefix: string, postgres = true) {
  const server = await startMultiProjectServer({ projects: [{ id: `${prefix}-a`, root: a.root }, { id: `${prefix}-b`, root: b.root }], indexConfig: postgres ? config() : undefined, port: 0, pollMs: 60_000 });
  servers.push(server);
  return server;
}
async function login(server: RunningMultiProjectServer, path: string, label: string) {
  const response = await fetch(`${server.url}${path}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'dev', token: `token-${label}` }) });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}
async function get(server: RunningMultiProjectServer, path: string, cookie: string) {
  const response = await fetch(`${server.url}${path}`, { headers: { cookie } });
  return { status: response.status, body: await response.json() };
}
async function answer(server: RunningMultiProjectServer, path: string, cookie: string) {
  return fetch(`${server.url}${path}/api/changes/same/questions/Q-1/answer`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'dev', text: '一次成功写入' }) });
}
async function subscription(server: RunningMultiProjectServer, path: string, cookie: string) {
  const socket = new Socket(`${server.url.replace('http', 'ws')}${path}`, { headers: { cookie } });
  sockets.push(socket);
  const messages: { type: string; event?: { seq: number } }[] = [];
  socket.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 hello 超时')), 5000);
    socket.on('error', reject);
    socket.on('message', () => { if (messages.some((message) => message.type === 'hello')) { clearTimeout(timer); resolve(); } });
  });
  return { socket, messages };
}

/** 真实 pg 驱动经过 TCP 代理；断开时关闭监听与现有连接，恢复时仍使用原端口。 */
async function transport() {
  const target = new URL(connectionString);
  const connections = new Set<TcpSocket>();
  const listener = createServer((incoming) => {
    const outgoing = connect({ host: target.hostname, port: Number(target.port || 5432) });
    for (const socket of [incoming, outgoing]) {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
      socket.on('error', () => { incoming.destroy(); outgoing.destroy(); });
    }
    incoming.pipe(outgoing); outgoing.pipe(incoming);
  });
  const listen = async (port: number) => { listener.listen(port, '127.0.0.1'); await once(listener, 'listening'); };
  await listen(0);
  const port = (listener.address() as AddressInfo).port;
  const proxyUrl = new URL(connectionString); proxyUrl.hostname = '127.0.0.1'; proxyUrl.port = String(port);
  const close = async () => {
    const done = listener.listening ? new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())) : Promise.resolve();
    for (const socket of connections) socket.destroy();
    await done;
  };
  const proxy = { url: proxyUrl.href, close, restore: () => listen(port) };
  proxies.push(proxy);
  return proxy;
}

describe('真实 Postgres 服务综合验收（T4.3f）', () => {
  it('完整多项目服务 SQLite → Postgres → SQLite，查询、源文件、事件哈希与 Git 锚定一致', async () => {
    const a = project('migration-a'); const b = project('migration-b');
    for (const store of [a, b]) anchorLog(store);
    const before = [a, b].map((store) => ({ files: sourceFiles(store), anchors: readLogAnchors(store.root), head: headSha(store.root) }));
    const snapshots = [];
    for (const postgres of [false, true, false]) {
      const server = await multi(a, b, 'migration', postgres);
      const responses = [];
      for (const [id, label, store] of [['a', 'migration-a', a], ['b', 'migration-b', b]] as const) {
        const path = `/p/migration-${id}`;
        const cookie = await login(server, path, label);
        expect((await get(server, `${path}/api/index`, cookie)).body.index).toEqual({ backend: postgres ? 'postgres' : 'sqlite', state: 'ready', lastSyncedSeq: store.events().length });
        for (const endpoint of ['/changes', '/changes?stage=analysis', '/changes/same', '/changes/same/questions?severity=blocking', '/changes/same/gates', '/events?after=1&limit=2', '/log/verify']) {
          const result = await get(server, `${path}/api${endpoint}`, cookie);
          expect(result.status).toBe(200);
          // 门禁实时重算的时间本应不同，其余业务结果必须逐字段相同。
          responses.push(JSON.parse(JSON.stringify(result.body, (key, value) => key === 'evaluatedAt' ? undefined : value)));
        }
      }
      snapshots.push(responses);
      await server.close(); servers.splice(servers.indexOf(server), 1);
      expect([a, b].map((store) => ({ files: sourceFiles(store), anchors: readLogAnchors(store.root), head: headSha(store.root) }))).toEqual(before);
    }
    expect(snapshots[1]).toEqual(snapshots[0]); expect(snapshots[2]).toEqual(snapshots[0]);
  });

  it('真实连接中断关闭订阅、读写 503；恢复只补索引，不重放成功的文件操作', async () => {
    const proxy = await transport(); process.env[environment] = proxy.url;
    const a = project('network-a'); const b = project('network-b');
    const server = await multi(a, b, 'network');
    const cookieA = await login(server, '/p/network-a', 'network-a');
    const cookieB = await login(server, '/p/network-b', 'network-b');
    expect((await get(server, '/p/network-b/api/changes', cookieA)).status).toBe(401);
    const first = await subscription(server, '/p/network-a/ws', cookieA);
    const second = await subscription(server, '/p/network-b/ws', cookieB);
    const closed = Promise.all([once(first.socket, 'close'), once(second.socket, 'close')]);
    const last = a.events().length;
    expect((await answer(server, '/p/network-a', cookieA)).status).toBe(200);
    const aFiles = sourceFiles(a); const bFiles = sourceFiles(b);
    await proxy.close();
    await server.tick(); await closed;
    const status = await get(server, '/p/network-a/api/index', cookieA);
    expect(status).toMatchObject({ status: 503, body: { index: { backend: 'postgres', state: 'stale', lastSyncedSeq: last } } });
    const unavailable = await get(server, '/p/network-a/api/changes', cookieA);
    expect(unavailable).toMatchObject({ status: 503, body: { error: { code: 'index_unavailable' } } });
    expect(JSON.stringify(unavailable)).not.toMatch(/127\.0\.0\.1|postgresql|sf_accept_|password/);
    expect((await answer(server, '/p/network-a', cookieA)).status).toBe(503);
    expect(sourceFiles(a)).toEqual(aFiles); expect(sourceFiles(b)).toEqual(bFiles);
    await proxy.restore();
    await server.tick();
    expect((await get(server, '/p/network-a/api/index', cookieA)).body.index).toMatchObject({ state: 'ready', lastSyncedSeq: last + 1 });
    const reconnected = await subscription(server, `/p/network-a/ws?after=${last}`, cookieA);
    await server.tick();
    // 补发发生在 hello 之后，等待一次服务端响应以排空已发送消息。
    await get(server, '/p/network-a/api/events', cookieA);
    expect(reconnected.messages.filter((message) => message.type === 'event').map((message) => message.event?.seq)).toEqual([last + 1]);
    expect(a.load('same').questions[0]?.revisions).toHaveLength(1);
    expect(sourceFiles(a)).toEqual(aFiles); expect(sourceFiles(b)).toEqual(bFiles);
  });

  it('真实 SQL 事务中途失败回滚事件与游标，一个项目失败不阻塞健康项目', async () => {
    const a = project('trigger-a'); const b = project('trigger-b');
    const server = await multi(a, b, 'trigger');
    const cookieA = await login(server, '/p/trigger-a', 'trigger-a');
    const cookieB = await login(server, '/p/trigger-b', 'trigger-b');
    const before = a.events().length;
    indexQuestion(a, 'same', 'Q-2');
    const files = sourceFiles(a);
    await pool.query(`CREATE FUNCTION specforge_index.fail_sync() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.project_id = 'trigger-a' THEN RAISE EXCEPTION 'private-db-secret'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_sync BEFORE UPDATE ON specforge_index.projects FOR EACH ROW EXECUTE FUNCTION specforge_index.fail_sync()`);
    try {
      const failed = await get(server, '/p/trigger-a/api/events', cookieA);
      expect(failed.status).toBe(503); expect(JSON.stringify(failed)).not.toContain('private-db-secret');
      expect((await pool.query("SELECT count(*)::int AS count FROM specforge_index.events WHERE project_id = 'trigger-a'")).rows[0]?.count).toBe(before);
      expect((await pool.query("SELECT last_seq FROM specforge_index.projects WHERE project_id = 'trigger-a'")).rows[0]?.last_seq).toBe(String(before));
      expect((await get(server, '/p/trigger-b/api/changes', cookieB)).status).toBe(200);
      expect((await get(server, '/p/trigger-a/api/index', cookieA)).body.index).toMatchObject({ state: 'stale', lastSyncedSeq: before });
    } finally { await pool.query('DROP TRIGGER fail_sync ON specforge_index.projects; DROP FUNCTION specforge_index.fail_sync()'); }
    for (let attempt = 0; attempt < 2; attempt++) expect((await get(server, '/p/trigger-a/api/events', cookieA)).body.events).toHaveLength(before + 1);
    expect(sourceFiles(a)).toEqual(files);
  });

  it('未知 schema 在真实服务启动时拒绝，保持原索引和源文件', async () => {
    const store = project('schema');
    const initial = await PostgresIndex.open(store, 'schema', connectionString); indexes.push(initial);
    await initial.sync();
    const files = sourceFiles(store);
    await pool.query('UPDATE specforge_index.schema_version SET version = 99');
    try {
      await expect(startServer({ store, port: 0, indexConfig: { ...config(), projectId: 'schema' } })).rejects.toMatchObject({ code: 'index_schema' });
      const server = await multi(store, project('schema-other'), 'unknown');
      const response = await fetch(`${server.url}/p/unknown-a/api/changes`);
      expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: { code: 'project_unavailable' } });
      expect((await pool.query("SELECT count(*)::int AS count FROM specforge_index.events WHERE project_id = 'schema'")).rows[0]?.count).toBe(store.events().length);
    } finally { await pool.query('UPDATE specforge_index.schema_version SET version = 1'); }
    expect(sourceFiles(store)).toEqual(files);
  });

  it('真实角色权限不足启动失败；运行中撤销写权限时不返回陈旧列表，授权恢复后增量同步', async () => {
    const store = project('permission');
    const files = sourceFiles(store);
    await expect(PostgresIndex.open(store, 'permission', limitedUrl.href)).rejects.toMatchObject({ code: 'index_unavailable' });
    expect(sourceFiles(store)).toEqual(files);
    await pool.query(`GRANT USAGE ON SCHEMA specforge_index TO "${role}"; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA specforge_index TO "${role}"`);
    process.env[environment] = limitedUrl.href;
    const server = await startServer({ store, port: 0, pollMs: 60_000, indexConfig: { ...config(), projectId: 'permission' } }); servers.push(server);
    const cookie = await login(server, '', 'permission');
    const before = store.events().length;
    indexQuestion(store, 'same', 'Q-2');
    const changedFiles = sourceFiles(store);
    await pool.query(`REVOKE UPDATE ON specforge_index.projects FROM "${role}"`);
    try {
      expect((await get(server, '/api/changes', cookie)).status).toBe(503);
      expect((await get(server, '/api/index', cookie)).body.index).toMatchObject({ state: 'stale', lastSyncedSeq: before });
      expect((await answer(server, '', cookie)).status).toBe(503);
      expect((await pool.query("SELECT count(*)::int AS count FROM specforge_index.events WHERE project_id = 'permission'")).rows[0]?.count).toBe(before);
    } finally { await pool.query(`GRANT UPDATE ON specforge_index.projects TO "${role}"`); }
    expect((await get(server, '/api/events', cookie)).body.events).toHaveLength(before + 1);
    expect(sourceFiles(store)).toEqual(changedFiles);
  });
});
