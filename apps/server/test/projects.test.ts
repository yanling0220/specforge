import { execFileSync, fork, spawn, type ChildProcess } from 'node:child_process';
import { once, type EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { addUser, createQuestion, disableUser, emptyAnalysis, rotateToken, sha256 } from '@specforge/core';
import { headSha } from '@specforge/runner';
import { anchorLog, defaultConfig, Store } from '@specforge/store';
import type { Actor } from '@specforge/shared';
import { readProjects, registerProjects } from '../src/projects.ts';
import { startMultiProjectServer, type RunningMultiProjectServer } from '../src/server.ts';

const Socket = createRequire(import.meta.url)('ws') as new (url: string, options: { headers: { cookie: string } }) => EventEmitter & { close(): void };
const directories: string[] = [];
const servers: RunningMultiProjectServer[] = [];
const sockets: InstanceType<typeof Socket>[] = [];
const children: ChildProcess[] = [];
const admin: Actor = { name: 'same', role: 'dev' };
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  }
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function project(label: string, users = true): Store {
  const root = mkdtempSync(join(tmpdir(), 'sf-projects-'));
  directories.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(root, 'code.js'), 'export const value = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  mkdirSync(join(root, '.specforge', 'changes'), { recursive: true });
  writeFileSync(join(root, '.specforge', 'config.json'), JSON.stringify(defaultConfig()));
  const store = new Store(root);
  if (users) store.mutateUsers(admin, 'user.added', (registry) => addUser(registry, { name: 'same', roles: ['dev', 'product'], admin: true }, sha256(`token-${label}`), undefined, 'T'), {});
  store.create({
    change: { id: 'same', title: label, tier: 'M', stage: 'analysis', baseSha: headSha(root), createdAt: 'T', createdBy: admin },
    analysis: emptyAnalysis(defaultConfig()),
    questions: [], reviews: [], approvals: [],
  }, admin);
  store.mutate('same', admin, 'question.raised', (state) => ({ ...state, questions: [createQuestion({ id: 'Q-1', question: label, category: '业务规则', severity: 'blocking', raisedAtStage: 'analysis' }, store.config(), admin, 'T')] }), () => ({ questionId: 'Q-1' }));
  store.saveEvidence('same', { id: 'ev-1', sha: headSha(root), startedAt: 'T', finishedAt: 'T', mainTreeDirty: false, steps: [{ name: 'test', command: 'test', exitCode: 0, timedOut: false, durationMs: 1, outputTail: label, outputHash: sha256(label) }], host: { node: 'v', platform: 'p' } }, admin);
  return store;
}

async function setup(first = project('A'), second = project('B')) {
  const server = await startMultiProjectServer({ projects: [{ id: 'a', root: first.root }, { id: 'b', root: second.root }], port: 0, pollMs: 20 });
  servers.push(server);
  const fetchProject = (id: string, path: string, cookie?: string, init: RequestInit = {}) => fetch(`${server.url}/p/${id}${path}`, { ...init, headers: { ...(cookie ? { cookie } : {}), ...init.headers } });
  const login = (id: string, token: string) => fetchProject(id, '/api/auth/login', undefined, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'same', token }) });
  const cookie = (response: Response) => response.headers.get('set-cookie')!.split(';')[0]!;
  return { server, first, second, fetchProject, login, cookie };
}

function connect(url: string, cookie: string) {
  const socket = new Socket(url, { headers: { cookie } });
  sockets.push(socket);
  const messages: Record<string, any>[] = [];
  socket.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString())));
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('等待 WebSocket 消息超时');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { socket, messages, waitFor };
}

async function upgradeStatus(url: string, cookie?: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(cookie ? { cookie } : {}) } });
    outgoing.on('response', (response) => { response.resume(); resolve(response.statusCode); });
    outgoing.on('upgrade', (_, socket) => { socket.destroy(); resolve(101); });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

describe('项目登记（T4.3b）', () => {
  it('从服务端 JSON 读取登记，路径相对于配置文件；不修改源数据', () => {
    const store = project('A');
    const file = join(store.root, 'projects.json');
    const before = readFileSync(store.path('events.jsonl'), 'utf8');
    writeFileSync(file, JSON.stringify({ version: 1, projects: [{ id: 'a', root: '.' }] }));
    const entries = readProjects(file);
    expect(entries).toEqual([{ id: 'a', root: store.root }]);
    expect(registerProjects(entries)[0]!.store.root).toBe(realpathSync(store.root));
    expect(readFileSync(store.path('events.jsonl'), 'utf8')).toBe(before);
    for (const invalid of ['null', '{}', '{"version":2,"projects":[]}', '{"version":1,"projects":[null]}', 'secret-invalid-json']) {
      writeFileSync(file, invalid);
      expect(() => readProjects(file)).toThrow(/version=1/);
    }
  });

  it('拒绝空登记、无效或重复 ID、非 Git 根目录和未初始化目录', () => {
    const store = project('A');
    expect(() => registerProjects([])).toThrow();
    for (const id of ['../a', 'a/b', 'A', 'a'.repeat(65), '']) expect(() => registerProjects([{ id, root: store.root }])).toThrow(/ID/);
    expect(() => registerProjects([{ id: 'a', root: store.root }, { id: 'a', root: store.root }])).toThrow(/ID/);
    expect(() => registerProjects([{ id: 'a', root: '.' }])).toThrow(/绝对路径/);
    mkdirSync(join(store.root, 'child'));
    expect(() => registerProjects([{ id: 'a', root: join(store.root, 'child') }])).toThrow(/根目录/);
    expect(() => registerProjects([{ id: 'a', root: tmpdir() }])).toThrow(/Git/);
    rmSync(store.path('config.json'));
    expect(() => registerProjects([{ id: 'a', root: store.root }])).toThrow(/初始化/);
  });

  it('拒绝同仓库符号链接别名、共享 Git 元数据的 worktree 和外置状态目录', () => {
    const first = project('A');
    const second = project('B');
    const alias = join(second.root, 'alias');
    symlinkSync(first.root, alias);
    expect(() => registerProjects([{ id: 'a', root: first.root }, { id: 'alias', root: alias }])).toThrow(/重复/);
    const worktree = join(second.root, 'worktree');
    execFileSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: first.root, stdio: ['ignore', 'pipe', 'pipe'] });
    mkdirSync(join(worktree, '.specforge'));
    writeFileSync(join(worktree, '.specforge', 'config.json'), JSON.stringify(defaultConfig()));
    expect(() => registerProjects([{ id: 'a', root: first.root }, { id: 'worktree', root: worktree }])).toThrow(/Git 元数据/);
    renameSync(second.path(), join(second.root, 'saved'));
    symlinkSync(first.path(), second.path());
    expect(() => registerProjects([{ id: 'b', root: second.root }])).toThrow(/初始化/);
  });
});

describe('多项目 REST 与会话（T4.3b）', () => {
  it('同名用户、change、Q、证据和事件序号仍隔离，Cookie 路径与名称独立', async () => {
    const { server, first, second, fetchProject, login, cookie } = await setup();
    expect((await fetchProject('a', '/api/changes')).status).toBe(401);
    const firstLogin = await login('a', 'token-A');
    expect(firstLogin.status).toBe(200);
    expect(firstLogin.headers.get('set-cookie')).toMatch(/sf_session_a=.*Path=\/p\/a;.*HttpOnly.*SameSite=Strict/);
    const firstCookie = cookie(firstLogin);
    expect((await login('b', 'token-A')).status).toBe(401);
    expect((await fetchProject('b', '/api/changes', firstCookie)).status).toBe(401);
    expect((await fetchProject('b', '/api/changes', firstCookie.replace('sf_session_a=', 'sf_session_b='))).status).toBe(401);
    const secondCookie = cookie(await login('b', 'token-B'));
    const combined = `${firstCookie}; ${secondCookie}`;
    expect(await (await fetchProject('a', '/api/project', combined)).json()).toEqual({ id: 'a', readOnly: false });
    expect(await (await fetchProject('b', '/api/project', combined)).json()).toEqual({ id: 'b', readOnly: false });
    for (const [id, label, store] of [['a', 'A', first], ['b', 'B', second]] as const) {
      expect((await (await fetchProject(id, '/api/changes', combined)).json()).changes[0].title).toBe(label);
      expect((await (await fetchProject(id, '/api/changes/same', combined)).json()).change.title).toBe(label);
      expect((await (await fetchProject(id, '/api/changes/same/questions/Q-1', combined)).json()).question).toBe(label);
      expect((await (await fetchProject(id, '/api/changes/same/questions?status=open', combined)).json()).questions).toHaveLength(1);
      expect((await (await fetchProject(id, '/api/changes?stage=spec', combined)).json()).changes).toEqual([]);
      expect((await (await fetchProject(id, '/api/events?after=2&limit=1', combined)).json()).events.map((event: { seq: number }) => event.seq)).toEqual([3]);
      expect((await (await fetchProject(id, '/api/changes/same/evidence/ev-1', combined)).json()).content.steps[0].outputTail).toBe(label);
      expect((await (await fetchProject(id, '/api/changes/same/gates', combined)).json()).stage).toBe('analysis');
      expect((await (await fetchProject(id, '/api/log/verify', combined)).json()).events).toBe(store.events().length);
      expect(await (await fetchProject(id, '/api/health')).json()).toEqual({ ok: true });
    }
    await fetchProject('a', '/api/auth/logout', combined, { method: 'POST' });
    expect((await fetchProject('a', '/api/changes', combined)).status).toBe(401);
    expect((await fetchProject('b', '/api/changes', combined)).status).toBe(200);
    for (const path of ['/api/projects', '/api/changes', '/api/events', '/ws', '/p/missing/api/changes']) {
      const response = await fetch(`${server.url}${path}`, { headers: { cookie: combined } });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(first.root);
    }
    expect(await (await fetch(`${server.url}/api/health`)).json()).toEqual({ ok: true, mode: 'multi-project', readOnly: false });
  });

  it('写入仅落到 URL 所属项目，会话和角色仍校验，伪造 projectId 不能切换上下文', async () => {
    const { first, second, fetchProject, login, cookie } = await setup();
    const session = cookie(await login('a', 'token-A'));
    const before = { state: second.load('same'), events: second.events() };
    const post = (id: string, role: string, path = 'questions/Q-1/answer', extra = {}) => fetchProject(id, `/api/changes/same/${path}`, session, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'b', name: 'forged', role, text: 'new A', ...extra }) });
    expect((await post('b', 'dev')).status).toBe(401);
    expect((await post('a', 'agent')).status).toBe(403);
    expect((await post('a', 'dev')).status).toBe(200);
    const revision = first.load('same').questions[0]!.revisions.at(-1)!;
    expect((await post('a', 'product', 'questions/Q-1/confirm', { rev: revision.rev, answerHash: revision.hash })).status).toBe(200);
    expect((await post('a', 'dev', 'questions/Q-1/answer', { reason: '补充说明' })).status).toBe(200);
    expect((await post('a', 'product', 'questions/Q-1/confirm', { rev: revision.rev, answerHash: revision.hash })).status).toBe(409);
    const latest = first.load('same').questions[0]!.revisions.at(-1)!;
    expect((await post('a', 'product', 'questions/Q-1/reject', { rev: latest.rev, answerHash: latest.hash, note: '重新核对' })).status).toBe(200);
    expect(first.events().at(-1)!.actor).toEqual({ name: 'same', role: 'product' });
    expect(first.load('same').questions[0]!.revisions.at(-1)!.text).toBe('new A');
    expect((await (await fetchProject('a', '/api/changes/same?projectId=b', session)).json()).change.title).toBe('A');
    expect({ state: second.load('same'), events: second.events() }).toEqual(before);
  });

  it('拒绝参数路径穿越，不从任何默认项目回退读取', async () => {
    const { server, fetchProject, login, cookie } = await setup();
    const session = cookie(await login('a', 'token-A'));
    for (const segment of ['..%2Fb', '%2e%2e%5cb', '%252e%252e', '%00']) {
      expect((await fetchProject('a', `/api/changes/${segment}`, session)).status).toBe(400);
      expect((await fetch(`${server.url}/p/${segment}/api/changes`, { headers: { cookie: session } })).status).toBe(400);
    }
    expect((await fetchProject('a', '/api/changes/missing', session)).status).toBe(404);
    expect((await upgradeStatus(`${server.url}/p/a/ws?changeId=..%2Fb`, session))).toBe(400);
  });

  it('CLI 与 HTTP 共用锁；忙时不写入、不关闭健康订阅，进程死亡后要求显式恢复', async () => {
    const { server, first, second, fetchProject, login, cookie } = await setup();
    const session = cookie(await login('a', 'token-A'));
    const secondSession = cookie(await login('b', 'token-B'));
    const before = first.events().length;
    const connection = connect(`${server.url.replace('http', 'ws')}/p/a/ws`, session);
    await connection.waitFor(() => connection.messages.some((message) => message.type === 'hello'));
    const worker = fileURLToPath(new URL('../../../packages/store/test/fixtures/writer.ts', import.meta.url));
    const child = fork(worker, [first.root, 'hold'], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child);
    const exited = once(child, 'exit');
    await once(child, 'message');
    const locked = once(child, 'message'); child.send('go'); await locked;
    const post = () => fetchProject('a', '/api/changes/same/questions/Q-1/answer', session, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'dev', text: 'after lock' }) });
    const blocked = await post();
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe('write_busy');
    const main = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url));
    expect(() => execFileSync(process.execPath, [main, 'q', 'answer', 'same', 'Q-1', '--text', 'blocked', '--as', 'same:dev'], { cwd: first.root, stdio: ['ignore', 'pipe', 'pipe'] })).toThrow();
    server.tick();
    expect((await fetchProject('b', '/api/changes', secondSession)).status).toBe(200);
    second.append({ type: 'healthy.b', actor: admin, payload: {} });
    const closed = once(connection.socket, 'close');
    child.kill('SIGKILL'); await exited;
    expect((await post()).status).toBe(503);
    server.tick(); await closed;
    first.recover('确认临时测试进程未写入文件');
    expect(first.events()).toHaveLength(before);
    expect((await post()).status).toBe(200);
    expect(first.events()).toHaveLength(before + 1);
    expect((await fetchProject('b', '/api/changes', secondSession)).status).toBe(200);
  });

  it('正文尚未接收完整的请求不占用仓库锁，接收后按最新状态写入', async () => {
    const { server, first, fetchProject, login, cookie } = await setup();
    const session = cookie(await login('a', 'token-A'));
    const body = JSON.stringify({ role: 'dev', text: 'slow upload' });
    const outgoing = request(`${server.url}/p/a/api/changes/same/questions/Q-1/answer`, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    const responded = once(outgoing, 'response');
    outgoing.write(body.slice(0, 4));
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((await fetchProject('a', '/api/changes', session)).status).toBe(200);
      first.append({ type: 'during.upload', actor: admin, payload: {} });
      outgoing.end(body.slice(4));
      const [response] = await responded;
      response.resume();
      expect(response.statusCode).toBe(200);
      expect(first.events().slice(-2).map((event) => event.type)).toEqual(['during.upload', 'question.answered']);
    } finally { outgoing.destroy(); }
  });

  it('项目启动时损坏或没有用户名册，只让该项目不可用，错误不泄露路径或内容', async () => {
    const first = project('A', false);
    const second = project('B');
    writeFileSync(first.path('config.json'), 'secret-invalid-json');
    const { fetchProject, login, cookie } = await setup(first, second);
    const failed = await fetchProject('a', '/api/changes');
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toMatch(/secret|sf-projects-|SyntaxError/);
    expect((await fetchProject('b', '/api/changes', cookie(await login('b', 'token-B')))).status).toBe(200);
    const noUsers = await startMultiProjectServer({ projects: [{ id: 'a', root: project('C', false).root }], port: 0 });
    servers.push(noUsers);
    expect((await fetch(`${noUsers.url}/p/a/api/auth/me`)).status).toBe(503);
  });

  it('运行时损坏、移走或替换登记仓库时失败关闭，健康项目继续提供查询', async () => {
    const { first, server, fetchProject, login, cookie } = await setup();
    const firstCookie = cookie(await login('a', 'token-A'));
    const secondCookie = cookie(await login('b', 'token-B'));
    const config = readFileSync(first.path('config.json'), 'utf8');
    writeFileSync(first.path('config.json'), 'invalid');
    expect((await fetchProject('a', '/api/changes', firstCookie)).status).toBe(503);
    server.tick();
    expect((await fetchProject('b', '/api/changes', secondCookie)).status).toBe(200);
    writeFileSync(first.path('config.json'), config);
    expect((await fetchProject('a', '/api/changes', firstCookie)).status).toBe(200);
    const moved = `${first.root}-moved`;
    directories.push(moved);
    renameSync(first.root, moved);
    expect((await fetchProject('a', '/api/changes', firstCookie)).status).toBe(503);
    mkdirSync(first.root);
    expect((await fetchProject('a', '/api/changes', firstCookie)).status).toBe(503);
    expect((await fetchProject('b', '/api/changes', secondCookie)).status).toBe(200);
  });

  it.each(['changes/same', 'changes/same/evidence'])('拒绝运行时用 %s 符号链接绕到其他项目', async (path) => {
    const { first, second, fetchProject, login, cookie } = await setup();
    const firstCookie = cookie(await login('a', 'token-A'));
    const secondCookie = cookie(await login('b', 'token-B'));
    renameSync(first.path(path), first.path(`${path}-saved`));
    symlinkSync(second.path(path), first.path(path));
    expect(() => registerProjects([{ id: 'a', root: first.root }])).toThrow(/初始化/);
    expect((await fetchProject('a', '/api/changes/same', firstCookie)).status).toBe(503);
    expect((await fetchProject('a', '/api/changes/same/evidence/ev-1', firstCookie)).status).toBe(503);
    expect((await fetchProject('b', '/api/changes/same', secondCookie)).status).toBe(200);
  });

  it('各项目独立读取 Git 锚定，配置的定时锚定也不改动其他仓库', async () => {
    const first = project('A');
    const second = project('B');
    anchorLog(first);
    writeFileSync(second.path('config.json'), JSON.stringify({ ...second.config(), audit: { anchorIntervalMs: 1000 } }));
    const { fetchProject, login, cookie } = await setup(first, second);
    const firstCookie = cookie(await login('a', 'token-A'));
    const secondCookie = cookie(await login('b', 'token-B'));
    const firstAnchor = (await (await fetchProject('a', '/api/log/verify', firstCookie)).json()).anchors.latest.commit;
    const secondAnchor = (await (await fetchProject('b', '/api/log/verify', secondCookie)).json()).anchors.latest.commit;
    expect(firstAnchor).not.toBe(secondAnchor);
    first.append({ type: 'only.a', actor: admin, payload: {} });
    expect((await (await fetchProject('b', '/api/log/verify', secondCookie)).json()).anchors.latest.commit).toBe(secondAnchor);
    expect((await (await fetchProject('a', '/api/log/verify', firstCookie)).json()).anchors.latest.commit).toBe(firstAnchor);
  });
});

describe('多项目 WebSocket（T4.3b）', () => {
  it('握手鉴权、实时消息与断线补发只属于当前项目', async () => {
    const { server, first, second, login, cookie } = await setup();
    const firstCookie = cookie(await login('a', 'token-A'));
    const secondCookie = cookie(await login('b', 'token-B'));
    expect(await upgradeStatus(`${server.url}/p/a/ws`)).toBe(401);
    expect(await upgradeStatus(`${server.url}/p/b/ws`, firstCookie.replace('sf_session_a=', 'sf_session_b='))).toBe(401);
    const firstConnection = connect(`${server.url.replace('http', 'ws')}/p/a/ws?changeId=same`, firstCookie);
    const secondConnection = connect(`${server.url.replace('http', 'ws')}/p/b/ws?after=2`, secondCookie);
    await firstConnection.waitFor(() => firstConnection.messages.some((message) => message.type === 'hello'));
    await secondConnection.waitFor(() => secondConnection.messages.filter((message) => message.type === 'event').length === 2);
    first.append({ type: 'only.a', actor: admin, changeId: 'same', payload: {} });
    second.append({ type: 'only.b', actor: admin, changeId: 'same', payload: {} });
    server.tick();
    await firstConnection.waitFor(() => firstConnection.messages.some((message) => message.event?.type === 'only.a'));
    await secondConnection.waitFor(() => secondConnection.messages.some((message) => message.event?.type === 'only.b'));
    expect(firstConnection.messages.some((message) => message.event?.type === 'only.b')).toBe(false);
    expect(secondConnection.messages.some((message) => message.event?.type === 'only.a')).toBe(false);
    expect(firstConnection.messages.filter((message) => message.type === 'changes')).toEqual([{ type: 'changes', ids: ['same'] }]);
  });

  it.each(['disable', 'rotate', 'logout'])('%s 后已连接的会话停止接收消息；其他项目的同名账号不受影响', async (action) => {
    const first = project('A');
    if (action === 'disable') first.mutateUsers(admin, 'user.added', (registry) => addUser(registry, { name: 'backup', roles: ['dev'], admin: true }, sha256('backup-token'), admin, 'T'), {});
    const { server, second, fetchProject, login, cookie } = await setup(first);
    const firstCookie = cookie(await login('a', 'token-A'));
    const secondCookie = cookie(await login('b', 'token-B'));
    const firstConnection = connect(`${server.url.replace('http', 'ws')}/p/a/ws`, firstCookie);
    const secondConnection = connect(`${server.url.replace('http', 'ws')}/p/b/ws`, secondCookie);
    await firstConnection.waitFor(() => firstConnection.messages.length === 1);
    await secondConnection.waitFor(() => secondConnection.messages.length === 1);
    const closed = once(firstConnection.socket, 'close');
    if (action === 'disable') first.mutateUsers(admin, 'user.disabled', (registry) => disableUser(registry, 'same', '离职', admin, 'T'), {});
    if (action === 'rotate') first.mutateUsers(admin, 'user.token_rotated', (registry) => rotateToken(registry, 'same', sha256('new-token'), admin, 'T'), {});
    if (action === 'logout') await fetchProject('a', '/api/auth/logout', firstCookie, { method: 'POST' });
    first.append({ type: 'secret.after.revoke', actor: admin, payload: {} });
    server.tick();
    await closed;
    expect(firstConnection.messages).toHaveLength(1);
    expect((await fetchProject('a', '/api/changes', firstCookie)).status).toBe(401);
    second.append({ type: 'still.b', actor: admin, payload: {} });
    server.tick();
    await secondConnection.waitFor(() => secondConnection.messages.some((message) => message.event?.type === 'still.b'));
    expect((await fetchProject('b', '/api/changes', secondCookie)).status).toBe(200);
  });

  it.each(['users.json', 'events.jsonl'])('%s 缺失或损坏后关闭订阅并拒绝读取，其他项目继续工作', async (file) => {
    const { server, first, fetchProject, login, cookie } = await setup();
    const firstCookie = cookie(await login('a', 'token-A'));
    const secondCookie = cookie(await login('b', 'token-B'));
    const connection = connect(`${server.url.replace('http', 'ws')}/p/a/ws`, firstCookie);
    await connection.waitFor(() => connection.messages.some((message) => message.type === 'hello'));
    const closed = once(connection.socket, 'close');
    if (file === 'users.json') rmSync(first.path(file));
    else writeFileSync(first.path(file), 'secret-invalid-json');
    const response = await fetchProject('a', '/api/changes', firstCookie);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/secret|sf-projects-|SyntaxError/);
    expect((await fetchProject('a', '/api/auth/me')).status).toBe(503);
    server.tick();
    expect((await closed)[0]).toBe(1008);
    expect(connection.messages).toHaveLength(1);
    expect((await fetchProject('b', '/api/changes', secondCookie)).status).toBe(200);
  });
});

describe('服务入口（T4.3b）', () => {
  it('--projects 可从项目外启动，并拒绝与 --db 混用', async () => {
    const store = project('A');
    const file = join(store.root, 'projects.json');
    writeFileSync(file, JSON.stringify({ version: 1, projects: [{ id: 'a', root: store.root }] }));
    const main = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
    expect(() => execFileSync(process.execPath, [main, '--projects', file, '--db', 'index.db'], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] })).toThrow();
    const child = spawn(process.execPath, [main, '--projects', file, '--port', '0'], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        child.on('exit', (code) => reject(new Error(`服务提前退出 ${code}`)));
        child.stdout.on('data', (data: Buffer) => {
          const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
          if (match) resolve(match[0]);
        });
      });
      expect((await fetch(`${url}/api/health`)).status).toBe(200);
      expect((await fetch(`${url}/p/a/api/changes`)).status).toBe(401);
    } finally {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  });
});
