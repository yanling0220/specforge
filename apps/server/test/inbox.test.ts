import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { confirmRestatement, disableUser, setRestatement, sha256 } from '@specforge/core';
import { headSha } from '@specforge/runner';
import { questionAction, recordReview, verifyLog, type Store } from '@specforge/store';
import type { InboxItem } from '@specforge/shared';
import { createApp } from '../src/app.ts';
import { ForgeIndex } from '../src/index-db.ts';
import { startMultiProjectServer, type RunningMultiProjectServer } from '../src/server.ts';
import { notificationProject } from './fixtures/notification-project.ts';
import { indexActor, indexProject } from './fixtures/index-project.ts';

const roots: string[] = [];
const indexes: ForgeIndex[] = [];
const servers: RunningMultiProjectServer[] = [];
const dev = indexActor;
const pm = { name: 'pm', role: 'product' as const };
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  indexes.splice(0).forEach((index) => index.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function project() {
  const store = notificationProject();
  roots.push(store.root);
  return store;
}

async function setup(store = project()) {
  const index = new ForgeIndex(store);
  indexes.push(index);
  const app = createApp(store, index);
  const cookies: Record<string, string> = {};
  for (const name of ['dev', 'pm']) {
    const response = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, token: `${name}-token` }) });
    expect(response.status).toBe(200);
    cookies[name] = response.headers.get('set-cookie')!.split(';')[0]!;
  }
  const get = (name: string, query = 'role=product') => app.request(`/api/inbox?${query}`, { headers: { cookie: cookies[name]! } });
  const items = async (name: string, role = name === 'pm' ? 'product' : 'dev'): Promise<InboxItem[]> => {
    const response = await get(name, `role=${role}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: InboxItem[] }).items;
  };
  const post = (path: string, name: string, body: object) => app.request(path, { method: 'POST', headers: { cookie: cookies[name]!, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { store, app, get, items, post };
}

function readyAnalysis(store: Store, id: string) {
  store.mutate(id, dev, 'restatement.confirmed', (state) => ({ ...state, analysis: {
    ...confirmRestatement(setRestatement(state.analysis, '示例需求'), dev, 'T'),
    dimensions: state.analysis.dimensions.map((dimension) => ({ ...dimension, status: 'covered' })),
  } }), () => ({}));
}

describe('项目审批收件箱 API（T4.6）', () => {
  it('身份只取会话，强制名册和有效角色；管理员也不能代看未授予角色', async () => {
    const { app, store, get } = await setup();
    expect((await app.request('/api/inbox?role=product')).status).toBe(401);
    expect((await get('pm', 'role=dev&name=dev')).status).toBe(403);
    expect((await get('dev', 'role=product&name=pm')).status).toBe(403);
    for (const query of ['', 'role=agent', 'role=unknown']) expect((await get('pm', query)).status).toBe(400);
    const response = await get('pm', 'role=product&name=dev&projectId=other');
    expect(response.status).toBe(200);
    expect(await response.text()).not.toMatch(/token|private-answer|ou_/);
    store.mutateUsers(dev, 'user.disabled', (registry) => disableUser(registry, 'pm', '停用', dev, 'T'), {});
    expect((await get('pm')).status).toBe(401);
    const noUsers = indexProject();
    roots.push(noUsers.root);
    const index = new ForgeIndex(noUsers);
    indexes.push(index);
    expect((await createApp(noUsers, index).request('/api/inbox?role=dev')).status).toBe(403);
  });

  it('反复读取不写事件、业务状态或发送账本；修订后引用更新，旧请求仍被拒绝', async () => {
    const { store, items, post } = await setup();
    const before = { state: store.load('same'), events: store.events() };
    const first = (await items('pm'))[0]!;
    expect(first).toMatchObject({ kind: 'question-confirmation', changeId: 'same', questionId: 'Q-1', rev: 1 });
    expect(await items('pm')).toEqual([first]);
    expect(await items('dev')).toEqual([]);
    expect({ state: store.load('same'), events: store.events() }).toEqual(before);
    questionAction(store, 'same', dev, 'Q-1', { kind: 'answer', text: '第二版' });
    const second = (await items('pm'))[0]!;
    expect(second.id).not.toBe(first.id);
    if (first.kind !== 'question-confirmation' || second.kind !== 'question-confirmation') throw new Error('缺少确认项');
    const stale = await post('/api/changes/same/questions/Q-1/confirm', 'pm', { role: 'product', rev: first.rev, answerHash: first.answerHash });
    expect(stale.status).toBe(409);
    expect((await post('/api/changes/same/questions/Q-1/confirm', 'pm', { role: 'product', rev: second.rev, answerHash: second.answerHash })).status).toBe(200);
    expect(await items('pm')).toEqual([]);
    expect(store.events().filter((event) => event.type.startsWith('notification.'))).toEqual([]);
    expect(verifyLog(store).ok).toBe(true);
  });

  it('规格审批按当前文件重算：审批后移除、内容改动重新出现、材料不合格时隐藏', async () => {
    const { store, items, post } = await setup();
    questionAction(store, 'same', pm, 'Q-1', { kind: 'confirm' });
    readyAnalysis(store, 'same');
    store.mutate('same', dev, 'stage.advanced', (state) => ({ ...state, change: { ...state.change, stage: 'spec' } }), () => ({ from: 'analysis', to: 'spec' }));
    const path = join(store.root, 'openspec/changes/same/specs/demo/spec.md');
    mkdirSync(join(path, '..'), { recursive: true });
    const text = '## ADDED Requirements\n### Requirement: 示例\n关联 Q-1。\n#### Scenario: [AC-1] 成功\n- **WHEN** 操作\n- **THEN** 成功\n';
    writeFileSync(path, text);
    const first = (await items('dev'))[0]!;
    expect(first.kind).toBe('spec-approval');
    expect(await items('pm')).toEqual([]);
    expect((await post('/api/changes/same/approve', 'dev', { role: 'dev', target: 'spec' })).status).toBe(200);
    expect(await items('dev')).toEqual([]);
    const events = store.events();
    writeFileSync(path, text.replaceAll('成功', '成功并返回计数'));
    expect((await items('dev'))[0]!.id).not.toBe(first.id);
    writeFileSync(path, text.replace('[AC-1]', ''));
    expect(await items('dev')).toEqual([]);
    expect(store.events()).toEqual(events);
  });

  it('签字绑定实际 HEAD；新提交撤回旧就绪项，重新验证审查后再出现，签字后移除', async () => {
    const { store, items, post } = await setup();
    store.create({ change: { id: 'ready', title: '待签字', tier: 'S', stage: 'closing', baseSha: headSha(store.root), createdAt: 'T', createdBy: dev }, analysis: { nodes: [], dimensions: [], assumptions: [] }, questions: [], reviews: [], approvals: [] }, dev);
    readyAnalysis(store, 'ready');
    const evidence = () => {
      const sha = headSha(store.root);
      const output = '# tests 1\n# pass 1\n';
      store.saveEvidence('ready', { id: `ev-${sha}`, sha, startedAt: 'T', finishedAt: 'T', mainTreeDirty: false, steps: store.config().verify.map(({ name, command }) => ({ name, command, exitCode: 0, timedOut: false, durationMs: 1, outputTail: output, outputHash: sha256(output) })), host: { node: 'v', platform: 'p' } }, dev);
      recordReview(store, 'ready', { name: 'reviewer', role: 'agent' }, { kind: 'agent', sha, at: 'T', verdict: 'pass', reviewer: { name: 'reviewer', role: 'agent' }, coverage: ['src/example.js'], findings: [] }, {}, () => {});
    };
    evidence();
    const first = (await items('dev'))[0]!;
    expect(first).toMatchObject({ kind: 'human-signoff', sha: headSha(store.root) });
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'next'], { cwd: store.root });
    expect(await items('dev')).toEqual([]);
    evidence();
    expect((await items('dev'))[0]!.id).not.toBe(first.id);
    expect((await post('/api/changes/ready/signoff', 'dev', { role: 'dev', verdict: 'pass' })).status).toBe(200);
    expect(await items('dev')).toEqual([]);
    expect(verifyLog(store).ok).toBe(true);
  });

  it('状态带外改动时返回不可用，修复后重新读取；不以空列表冒充没有待办', async () => {
    const { store, get, items } = await setup();
    const file = join(store.changeDir('same'), 'questions.json');
    const before = readFileSync(file, 'utf8');
    const events = store.events();
    writeFileSync(file, '[]\n');
    const response = await get('pm');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'inbox_unavailable' } });
    writeFileSync(file, before);
    expect(await items('pm')).toHaveLength(1);
    expect(store.events()).toEqual(events);
  });

  it('带部署前缀的双项目同名待办和会话隔离，处理 A 不影响 B', async () => {
    const a = project();
    const b = project();
    const server = await startMultiProjectServer({ projects: [{ id: 'a', root: a.root }, { id: 'b', root: b.root }], basePath: '/console/inbox', port: 0, pollMs: 60_000 });
    servers.push(server);
    const login = async (id: string) => {
      const response = await fetch(`${server.url}/p/${id}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'pm', token: 'pm-token' }) });
      expect(response.status).toBe(200);
      return response.headers.get('set-cookie')!.split(';')[0]!;
    };
    const ac = await login('a');
    const bc = await login('b');
    const get = (id: string, cookie: string) => fetch(`${server.url}/p/${id}/api/inbox?role=product`, { headers: { cookie } });
    expect((await get('b', ac)).status).toBe(401);
    expect((await get('b', ac.replace('sf_session_a=', 'sf_session_b='))).status).toBe(401);
    const before = { state: b.load('same'), events: b.events() };
    const ai = ((await (await get('a', ac)).json()) as { items: InboxItem[] }).items[0]!;
    if (ai.kind !== 'question-confirmation') throw new Error('缺少确认项');
    const result = await fetch(`${server.url}/p/a/api/changes/same/questions/Q-1/confirm`, { method: 'POST', headers: { cookie: ac, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'product', rev: ai.rev, answerHash: ai.answerHash, projectId: 'b' }) });
    expect(result.status).toBe(200);
    expect(await (await get('a', ac)).json()).toMatchObject({ role: 'product', items: [] });
    expect(((await (await get('b', bc)).json()) as { items: InboxItem[] }).items).toHaveLength(1);
    expect({ state: b.load('same'), events: b.events() }).toEqual(before);
    expect((await fetch(`${server.url}/api/inbox?role=product`)).status).toBe(404);
    expect((await fetch(`${server.url}/p/missing/api/inbox?role=product`)).status).toBe(404);
  });
});
