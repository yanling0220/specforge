import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createQuestion, emptyAnalysis } from '@specforge/core';
import { headSha } from '@specforge/runner';
import { defaultConfig, Store } from '@specforge/store';
import type { Actor } from '@specforge/shared';
import { createApp } from '../src/app.ts';
import { ForgeIndex } from '../src/index-db.ts';
import { startServer, type PushMessage, type RunningServer } from '../src/server.ts';

const dev: Actor = { name: 'yan', role: 'dev' };
const dirs: string[] = [];
const servers: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function project(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sf-server-'));
  dirs.push(dir);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.js'), 'x\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  mkdirSync(join(dir, '.specforge', 'changes'), { recursive: true });
  writeFileSync(join(dir, '.specforge', 'config.json'), JSON.stringify(defaultConfig()));
  const store = new Store(dir);
  for (const id of ['c1', 'c2']) {
    store.create(
      {
        change: { id, title: `示例 ${id}`, tier: 'M', stage: 'analysis', baseSha: headSha(dir), createdAt: 'T', createdBy: dev },
        analysis: emptyAnalysis(defaultConfig()),
        questions: [],
        reviews: [],
        approvals: [],
      },
      dev,
    );
  }
  return store;
}

const raise = (store: Store, id: string, qid: string, severity: 'blocking' | 'minor' = 'blocking') =>
  store.mutate(
    id,
    dev,
    'question.raised',
    (s) => ({ ...s, questions: [...s.questions, createQuestion({ id: qid, category: '业务规则', severity, question: `${qid}？`, raisedAtStage: 'analysis' }, store.config(), dev, 'T')] }),
    () => ({ questionId: qid }),
  );

describe('索引（文件为准）', () => {
  it('首次同步全部；之后只追加新事件、只重建受影响的 change', () => {
    const store = project();
    const index = new ForgeIndex(store);
    expect(index.sync()).toMatchObject({ changes: ['c1', 'c2'], rebuilt: false });
    expect(index.events()).toHaveLength(2);

    raise(store, 'c1', 'Q-1');
    const r = index.sync();
    expect(r).toMatchObject({ changes: ['c1'], rebuilt: false });
    expect(r.events.map((e) => e.type)).toEqual(['question.raised']);
    expect(index.changes().find((c) => c.id === 'c1')).toMatchObject({ openQuestions: 1, openBlocking: 1, lastEventSeq: 3 });
    expect(index.sync()).toMatchObject({ events: [], changes: [] });
    index.close();
  });

  it('事件日志被改写或截断：丢弃索引全量重建', () => {
    const store = project();
    const index = new ForgeIndex(store);
    raise(store, 'c1', 'Q-1');
    index.sync();
    const file = store.path('events.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8').split('\n').slice(0, 2).join('\n') + '\n');
    expect(index.sync()).toMatchObject({ rebuilt: true, changes: ['c1', 'c2'] });
    expect(index.events()).toHaveLength(2);
    index.close();
  });

  it('过滤与分页', () => {
    const store = project();
    raise(store, 'c1', 'Q-1');
    raise(store, 'c1', 'Q-2', 'minor');
    raise(store, 'c2', 'Q-1');
    const index = new ForgeIndex(store);
    index.sync();
    expect(index.questions('c1', { severity: 'minor' }).map((q) => q.id)).toEqual(['Q-2']);
    expect(index.events({ changeId: 'c1', type: 'question.raised' }).map((e) => e.seq)).toEqual([3, 4]);
    expect(index.events({ after: 3, limit: 1 }).map((e) => e.seq)).toEqual([4]);
    index.close();
  });
});

describe('REST 接口（只读）', () => {
  const setup = () => {
    const store = project();
    const index = new ForgeIndex(store);
    return { store, app: createApp(store, index), index };
  };
  const get = async (app: ReturnType<typeof createApp>, path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it('列表、详情、问题、事件、门禁', async () => {
    const { store, app, index } = setup();
    raise(store, 'c1', 'Q-1');
    // 列表请求前自动与文件同步
    const list = await get(app, '/api/changes');
    expect(list.body.changes.map((c: { id: string; openBlocking: number }) => [c.id, c.openBlocking])).toEqual([['c1', 1], ['c2', 0]]);
    expect((await get(app, '/api/changes?stage=spec')).body.changes).toEqual([]);

    const detail = await get(app, '/api/changes/c1');
    expect(detail.body).toMatchObject({ change: { id: 'c1', stage: 'analysis' }, outOfBand: null, factsSource: { kind: 'worktree' } });
    expect((await get(app, '/api/changes/c1/questions?status=open')).body.questions.map((q: { id: string }) => q.id)).toEqual(['Q-1']);
    expect((await get(app, '/api/changes/c1/questions/Q-1')).body).toMatchObject({ id: 'Q-1', revisions: [] });
    expect((await get(app, '/api/changes/c1/events')).body.events.map((e: { type: string }) => e.type)).toEqual(['change.created', 'question.raised']);
    expect((await get(app, '/api/events?after=2')).body.events).toHaveLength(1);

    const gates = await get(app, '/api/changes/c1/gates');
    expect(gates.body.stage).toBe('analysis');
    expect(gates.body.gates.G1.status).toBe('failed');
    expect(gates.body.gates.G1.checks.find((c: { id: string }) => c.id === 'blocking').detail).toMatch(/Q-1/);
    index.close();
  });

  it('详情包含问题确认进度与暂停的任务（由 core 规则计算）', async () => {
    const { store, app, index } = setup();
    raise(store, 'c1', 'Q-1');
    mkdirSync(join(store.root, 'openspec/changes/c1'), { recursive: true });
    writeFileSync(join(store.root, 'openspec/changes/c1/tasks.md'), '- [ ] T-1 a（AC-1）\n- [ ] T-2 b（AC-1）依赖 T-1\n');
    const body = (await get(app, '/api/changes/c1')).body;
    expect(body.restatementConfirmed).toBe(false);
    expect(body.questionProgress).toEqual({ 'Q-1': { resolved: false, missingRoles: ['dev', 'product'] } });
    expect(body.pausedTasks).toEqual({ 'T-1': ['Q-1'], 'T-2': ['Q-1'] });
    index.close();
  });

  it('门禁是实时评估：文件变化后立即反映，不读缓存', async () => {
    const { store, app, index } = setup();
    const before = (await get(app, '/api/changes/c1/gates')).body.gates.G1.boundTo.value;
    raise(store, 'c1', 'Q-1');
    expect((await get(app, '/api/changes/c1/gates')).body.gates.G1.boundTo.value).not.toBe(before);
    index.close();
  });

  it('带外修改与链校验；错误返回 404 / 400', async () => {
    const { store, app, index } = setup();
    expect((await get(app, '/api/log/verify')).body).toMatchObject({ ok: true, events: 2 });
    const f = store.path('changes', 'c1', 'change.json');
    writeFileSync(f, readFileSync(f, 'utf8').replace('"analysis"', '"spec"'));
    expect((await get(app, '/api/changes/c1')).body.outOfBand).toMatch(/最后一次记录是事件/);
    expect((await get(app, '/api/log/verify')).body).toMatchObject({ ok: false, outOfBand: [{ changeId: 'c1' }] });

    expect(await get(app, '/api/changes/nope')).toMatchObject({ status: 404, body: { error: { code: 'no_change' } } });
    expect(await get(app, '/api/changes/c1/questions/Q-9')).toMatchObject({ status: 404 });
    expect(await get(app, '/api/events?limit=abc')).toMatchObject({ status: 400, body: { error: { code: 'bad_arg' } } });
    expect(await get(app, '/api/nope')).toMatchObject({ status: 404 });
    expect((await app.request('/api/changes', { method: 'POST' })).status).toBe(404);
    index.close();
  });
});

describe('WebSocket 推送', () => {
  /** 连接并收集消息；until 满足时 resolve */
  function connect(url: string) {
    const ws = new WebSocket(url);
    const messages: PushMessage[] = [];
    let waiter: { until: (m: PushMessage[]) => boolean; resolve: () => void } | undefined;
    ws.addEventListener('message', (e) => {
      messages.push(JSON.parse(String(e.data)) as PushMessage);
      if (waiter?.until(messages)) waiter.resolve();
    });
    const waitFor = (until: (m: PushMessage[]) => boolean) =>
      new Promise<void>((resolve, reject) => {
        if (until(messages)) return resolve();
        const t = setTimeout(() => reject(new Error(`等待超时，已收到：${JSON.stringify(messages.map((m) => m.type))}`)), 3000);
        waiter = { until, resolve: () => (clearTimeout(t), resolve()) };
      });
    return { ws, messages, waitFor };
  }
  const events = (m: PushMessage[]) => m.flatMap((x) => (x.type === 'event' ? [x.event.seq] : []));

  it('写入事件后推送 event 与 changes；可按 change 过滤；REST 先同步也不会漏推', async () => {
    const store = project();
    const server = await startServer({ store, port: 0, pollMs: 20 });
    servers.push(server);
    const ws = server.url.replace('http', 'ws');
    const all = connect(`${ws}/ws`);
    const onlyC2 = connect(`${ws}/ws?changeId=c2`);
    await all.waitFor((m) => m[0]?.type === 'hello');
    await onlyC2.waitFor((m) => m[0]?.type === 'hello');
    expect(all.messages[0]).toEqual({ type: 'hello', lastSeq: 2 });

    raise(store, 'c1', 'Q-1');
    // REST 请求先把新事件同步进索引
    await fetch(`${server.url}/api/changes`);
    raise(store, 'c2', 'Q-1');
    await all.waitFor((m) => events(m).length === 2 && m.some((x) => x.type === 'changes' && x.ids.includes('c2')));
    expect(events(all.messages)).toEqual([3, 4]);
    await onlyC2.waitFor((m) => events(m).length === 1);
    expect(events(onlyC2.messages)).toEqual([4]);
    expect(onlyC2.messages.filter((m) => m.type === 'changes')).toEqual([{ type: 'changes', ids: ['c2'] }]);
    all.ws.close();
    onlyC2.ws.close();
  });

  it('同一批推送包含多个 change 时，按 change 订阅的客户端只收到自己的', async () => {
    const store = project();
    const server = await startServer({ store, port: 0, pollMs: 60_000 });
    servers.push(server);
    const onlyC2 = connect(`${server.url.replace('http', 'ws')}/ws?changeId=c2`);
    await onlyC2.waitFor((m) => m[0]?.type === 'hello');
    raise(store, 'c1', 'Q-1');
    raise(store, 'c2', 'Q-1');
    server.tick();
    await onlyC2.waitFor((m) => m.some((x) => x.type === 'changes'));
    expect(events(onlyC2.messages)).toEqual([4]);
    expect(onlyC2.messages.filter((m) => m.type === 'changes')).toEqual([{ type: 'changes', ids: ['c2'] }]);
    onlyC2.ws.close();
  });

  it('重连时用 after 补发错过的事件', async () => {
    const store = project();
    raise(store, 'c1', 'Q-1');
    const server = await startServer({ store, port: 0, pollMs: 20 });
    servers.push(server);
    const c = connect(`${server.url.replace('http', 'ws')}/ws?after=1`);
    await c.waitFor((m) => events(m).length === 2);
    expect(c.messages[0]).toEqual({ type: 'hello', lastSeq: 3 });
    expect(events(c.messages)).toEqual([2, 3]);
    c.ws.close();
  });

  it('默认只监听本机', async () => {
    const server = await startServer({ store: project(), port: 0 });
    servers.push(server);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('证据接口与 Web 托管（T3.2）', () => {
  it('证据目录与详情；文件被改动后 hashOk 为 false', async () => {
    const store = project();
    const sha = headSha(store.root);
    store.saveEvidence('c1', { id: 'ev-1', sha, startedAt: 'T', finishedAt: 'T', mainTreeDirty: false, steps: [{ name: 'test', command: 'x', exitCode: 1, timedOut: false, durationMs: 1, outputTail: 'boom', outputHash: 'h' }], host: { node: 'v', platform: 'p' } }, dev);
    const index = new ForgeIndex(store);
    const app = createApp(store, index);
    const list = (await (await app.request('/api/changes/c1/evidence')).json()) as { evidence: { id: string; kind: string; passed: boolean; hashOk: boolean }[] };
    expect(list.evidence).toEqual([expect.objectContaining({ id: 'ev-1', kind: 'verify', sha, passed: false, hashOk: true })]);
    const detail = (await (await app.request('/api/changes/c1/evidence/ev-1')).json()) as { content: { steps: { outputTail: string }[] } };
    expect(detail.content.steps[0]!.outputTail).toBe('boom');

    const f = store.path('changes', 'c1', 'evidence', 'ev-1.json');
    writeFileSync(f, readFileSync(f, 'utf8').replace('boom', 'fine'));
    expect(((await (await app.request('/api/changes/c1/evidence')).json()) as typeof list).evidence[0]!.hashOk).toBe(false);
    expect((await app.request('/api/changes/c1/evidence/ev-9')).status).toBe(404);
    index.close();
  });

  it('门禁接口返回流水线定义', async () => {
    const store = project();
    const index = new ForgeIndex(store);
    const body = (await (await createApp(store, index).request('/api/changes/c1/gates')).json()) as { pipeline: { stage: string; exitGate?: string }[] };
    expect(body.pipeline.map((p) => `${p.stage}:${p.exitGate ?? ''}`)).toEqual(['analysis:G1', 'spec:G2', 'design:G3', 'tasks:G4', 'implement:G5', 'closing:G6', 'delivered:']);
    index.close();
  });

  it('托管 Web 构建产物：静态文件、前端路由回退 index.html、不能越出目录、接口 404 仍是 JSON', async () => {
    const store = project();
    const web = mkdtempSync(join(tmpdir(), 'sf-web-'));
    dirs.push(web);
    mkdirSync(join(web, 'assets'));
    writeFileSync(join(web, 'index.html'), '<div id="root"></div>');
    writeFileSync(join(web, 'assets', 'a.js'), 'console.log(1)');
    const index = new ForgeIndex(store);
    const app = createApp(store, index, { webDir: web });

    const js = await app.request('/assets/a.js');
    expect([js.status, js.headers.get('content-type'), await js.text()]).toEqual([200, 'text/javascript; charset=utf-8', 'console.log(1)']);
    expect(await (await app.request('/')).text()).toContain('root');
    expect(await (await app.request('/some/route')).text()).toContain('root');
    const escape = await app.request('/../../.specforge/config.json');
    expect(await escape.text()).toContain('root');
    expect(await (await app.request('/%2e%2e/%2e%2e/etc/passwd')).text()).toContain('root');
    const api404 = await app.request('/api/nope');
    expect([api404.status, ((await api404.json()) as { error: { code: string } }).error.code]).toEqual([404, 'not_found']);
    index.close();
  });
});
