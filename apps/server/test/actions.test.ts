import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addUser, createQuestion, emptyAnalysis, sha256 } from '@specforge/core';
import { headSha } from '@specforge/runner';
import { defaultConfig, Store } from '@specforge/store';
import type { Question, Stage } from '@specforge/shared';
import { createApp } from '../src/app.ts';
import { ForgeIndex } from '../src/index-db.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });

const tokenOf = (name: string) => `tok-${name}`;
const reference = (question: Question) => ({ rev: question.revisions.at(-1)!.rev, answerHash: question.revisions.at(-1)!.hash });

function project(opts: { users?: boolean; stage?: Stage } = {}): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sf-act-'));
  dirs.push(dir);
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.email', 't@t');
  g(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.js'), 'x\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  mkdirSync(join(dir, '.specforge', 'changes'), { recursive: true });
  writeFileSync(join(dir, '.specforge', 'config.json'), JSON.stringify({ ...defaultConfig(), workflow: { maxFixRounds: 1 } }));
  const store = new Store(dir);
  const admin = { name: 'alice', role: 'dev' as const };
  if (opts.users !== false) {
    // 令牌与登录时使用同一个函数生成
    store.mutateUsers(admin, 'user.added', (r) => addUser(r, { name: 'alice', roles: ['dev'], admin: true }, sha256(tokenOf('alice')), undefined, 'T'), {});
    store.mutateUsers(admin, 'user.added', (r) => addUser(r, { name: 'lily', roles: ['product'] }, sha256(tokenOf('lily')), admin, 'T'), {});
  }
  const config = store.config();
  store.create(
    {
      change: { id: 'c1', title: '示例', tier: 'M', stage: opts.stage ?? 'analysis', baseSha: headSha(dir), createdAt: 'T', createdBy: admin },
      analysis: emptyAnalysis(config),
      questions: [createQuestion({ id: 'Q-1', category: '业务规则', severity: 'blocking', question: '能否导入 admin？', raisedAtStage: 'analysis', options: [{ id: 'A', text: '不能' }] }, config, admin, 'T')],
      reviews: [],
      approvals: [],
    },
    admin,
  );
  return store;
}

function setup(store: Store) {
  const index = new ForgeIndex(store);
  const app = createApp(store, index);
  const sessions: Record<string, string> = {};
  const login = async (name: string) => {
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, token: tokenOf(name) }) });
    if (!res.headers.get('set-cookie')) throw new Error(`登录失败 ${res.status} ${await res.text()}`);
    sessions[name] = res.headers.get('set-cookie')!.split(';')[0]!;
  };
  const post = async (path: string, as: string | undefined, body: Record<string, unknown>) => {
    const res = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(as ? { cookie: sessions[as]! } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { app, index, login, post, sessions };
}

describe('控制台写操作（T3.4）', () => {
  it('没有用户名册：不允许写', async () => {
    const { post, index } = setup(project({ users: false }));
    const r = await post('/api/changes/c1/questions/Q-1/answer', undefined, { role: 'dev', text: '不能' });
    expect(r).toMatchObject({ status: 403, body: { error: { code: 'no_registry' } } });
    index.close();
  });

  it('未登录 401；角色必须已授予；必须用 JSON（防 CSRF）', async () => {
    const { app, post, login, index, sessions } = setup(project());
    expect((await post('/api/changes/c1/questions/Q-1/answer', undefined, { role: 'dev', text: '不能' })).status).toBe(401);
    await login('lily');
    expect(await post('/api/changes/c1/questions/Q-1/answer', 'lily', { role: 'dev', text: '不能' })).toMatchObject({ status: 403, body: { error: { code: 'role_not_granted' } } });
    expect((await post('/api/changes/c1/questions/Q-1/answer', 'lily', { text: '不能' })).body.error.code).toBe('missing_arg');
    const form = await app.request('/api/changes/c1/advance', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: sessions.lily! }, body: 'role=dev' });
    expect(form.status).toBe(415);
    index.close();
  });

  it('回答 → 开发确认 → 产品本人确认；身份来自会话，写入哈希链', async () => {
    const store = project();
    const { post, login, index } = setup(store);
    await login('alice');
    await login('lily');
    const a = await post('/api/changes/c1/questions/Q-1/answer', 'alice', { role: 'dev', text: '不能，一律 member', optionId: 'A' });
    expect(a.body.question).toMatchObject({ status: 'drafted' });
    // 回答者的 dev 确认已自动记录；产品确认后变为已确认
    const c = await post('/api/changes/c1/questions/Q-1/confirm', 'lily', { role: 'product', ...reference(a.body.question), note: '同意', name: 'alice', actor: { name: 'alice', role: 'dev' } });
    expect(c.body.question.status).toBe('confirmed');
    const events = store.events().filter((e) => e.changeId === 'c1').slice(-2);
    expect(events.map((e) => [e.type, e.actor.name, e.actor.role])).toEqual([
      ['question.answered', 'alice', 'dev'],
      ['question.confirmed', 'lily', 'product'],
    ]);
    const confirmation = c.body.question.revisions.at(-1).confirmations.at(-1);
    expect(confirmation).toMatchObject({ actor: { name: 'lily', role: 'product' } });
    expect(confirmation.recordedBy).toBeUndefined();
    expect(events.at(-1)!.payload).toMatchObject({ rev: 1, answerHash: reference(a.body.question).answerHash, confirmer: { name: 'lily', role: 'product' } });
    expect(events.at(-1)!.payload.recordedBy).toBeUndefined();
    expect(store.outOfBand('c1')).toBeUndefined();
    index.close();
  });

  it.each(['confirm', 'reject'])('T4.2：产品从旧页面 %s 时拒绝作用于新答案，且不写状态或事件', async (action) => {
    const store = project();
    const { post, login, index } = setup(store);
    await login('alice');
    await login('lily');
    const first = await post('/api/changes/c1/questions/Q-1/answer', 'alice', { role: 'dev', text: '不能导入 admin' });
    const seen = first.body.question.revisions.at(-1);
    await post('/api/changes/c1/questions/Q-1/answer', 'alice', { role: 'dev', text: '允许导入 admin' });
    const state = store.load('c1');
    const events = store.events();
    const result = await post(`/api/changes/c1/questions/Q-1/${action}`, 'lily', { role: 'product', rev: seen.rev, answerHash: seen.hash, note: '旧页面的意见' });
    expect(result).toMatchObject({ status: 409, body: { error: { code: 'stale_answer' } } });
    expect(store.load('c1')).toEqual(state);
    expect(store.events()).toEqual(events);
    const fresh = await post(`/api/changes/c1/questions/Q-1/${action}`, 'lily', { role: 'product', ...reference(state.questions[0]!), note: '重新核对后操作' });
    expect(fresh.status).toBe(200);
    expect(store.events().at(-1)!.payload).toMatchObject({ rev: 2, answerHash: reference(state.questions[0]!).answerHash });
    index.close();
  });

  it.each(['confirm', 'reject'])('T4.2：%s 不能省略或伪造答案引用的格式', async (action) => {
    const store = project();
    const { post, login, index } = setup(store);
    await login('alice');
    await login('lily');
    const answer = await post('/api/changes/c1/questions/Q-1/answer', 'alice', { role: 'dev', text: '不能' });
    const seen = reference(answer.body.question);
    const state = store.load('c1');
    const events = store.events();
    for (const invalid of [{}, { rev: seen.rev }, { answerHash: seen.answerHash }, { ...seen, rev: 0 }, { ...seen, rev: 1.5 }, { ...seen, rev: '1' }, { ...seen, answerHash: 'fake' }]) {
      expect((await post(`/api/changes/c1/questions/Q-1/${action}`, 'lily', { role: 'product', note: '同意', ...invalid })).status).toBe(400);
    }
    expect(store.load('c1')).toEqual(state);
    expect(store.events()).toEqual(events);
    index.close();
  });

  it('代录：必须写渠道，代录对象必须在名册中且有该角色', async () => {
    const { post, login, index } = setup(project());
    await login('alice');
    const answer = await post('/api/changes/c1/questions/Q-1/answer', 'alice', { role: 'dev', text: '不能' });
    const seen = reference(answer.body.question);
    expect((await post('/api/changes/c1/questions/Q-1/confirm', 'alice', { role: 'dev', ...seen, onBehalfName: 'lily', onBehalfRole: 'product' })).body.error.code).toBe('via_required');
    expect((await post('/api/changes/c1/questions/Q-1/confirm', 'alice', { role: 'dev', ...seen, onBehalfName: 'bob', onBehalfRole: 'product', via: '会议' })).body.error.code).toBe('bad_proxy');
    const ok = await post('/api/changes/c1/questions/Q-1/confirm', 'alice', { role: 'dev', ...seen, onBehalfName: 'lily', onBehalfRole: 'product', via: '产品评审会' });
    expect(ok.body.question.revisions.at(-1).confirmations.at(-1)).toMatchObject({ role: 'product', actor: { name: 'lily' }, recordedBy: { name: 'alice' }, via: '产品评审会' });
    index.close();
  });

  it('驳回、推迟、作废；未知操作 404', async () => {
    const { post, login, index } = setup(project());
    await login('alice');
    await login('lily');
    const answer = await post('/api/changes/c1/questions/Q-1/answer', 'alice', { role: 'dev', text: '不能' });
    expect((await post('/api/changes/c1/questions/Q-1/reject', 'lily', { role: 'product', ...reference(answer.body.question), note: '要问运营' })).body.question.revisions.at(-1).state).toBe('rejected');
    expect((await post('/api/changes/c1/questions/Q-1/reject', 'lily', { role: 'product' })).body.error.code).toBe('missing_arg');
    expect((await post('/api/changes/c1/questions/Q-1/invalidate', 'alice', { role: 'dev', reason: '需求取消' })).body.question.status).toBe('invalidated');
    expect((await post('/api/changes/c1/questions/Q-1/delete', 'alice', { role: 'dev' })).status).toBe(404);
    index.close();
  });

  it('推进：门禁不通过时 409 并记录拒绝事件', async () => {
    const store = project();
    const { post, login, index } = setup(store);
    await login('alice');
    const r = await post('/api/changes/c1/advance', 'alice', { role: 'dev' });
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'gate_blocked' } } });
    expect(store.events().at(-1)).toMatchObject({ type: 'stage.advance_rejected', actor: { name: 'alice' } });
    index.close();
  });

  it('审批 spec 需要 dev；签字通过 / 打回（打回必须写原因，并在收尾阶段打回实现）', async () => {
    const store = project({ stage: 'closing' });
    const { post, login, index } = setup(store);
    await login('alice');
    await login('lily');
    expect((await post('/api/changes/c1/approve', 'lily', { role: 'product', target: 'spec' })).status).toBe(403);
    expect((await post('/api/changes/c1/approve', 'alice', { role: 'dev', target: 'spec' })).body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await post('/api/changes/c1/signoff', 'lily', { role: 'product', verdict: 'pass' })).status).toBe(403);
    expect((await post('/api/changes/c1/signoff', 'alice', { role: 'dev', verdict: 'fail' })).body.error.code).toBe('note_required');
    expect((await post('/api/changes/c1/signoff', 'alice', { role: 'dev', verdict: 'fail', findings: [{ severity: 'urgent', text: 'x' }] })).body.error.code).toBe('bad_arg');
    const back = await post('/api/changes/c1/signoff', 'alice', { role: 'dev', verdict: 'fail', note: '失败行号不对', findings: [{ severity: 'blocking', kind: 'missing', anchor: 'AC-2', text: '行号从 0 开始' }] });
    expect(back.body.review).toMatchObject({ kind: 'human', verdict: 'fail', reviewer: { name: 'alice', role: 'dev' } });
    expect(back.body.change.stage).toBe('implement');
    expect(back.body.change.fixRounds[0]).toMatchObject({ round: 1, source: 'human', findings: [{ anchor: 'AC-2' }] });
    expect(store.events().slice(-2).map((e) => e.type)).toEqual(['review.recorded', 'stage.sent_back']);
    index.close();
  });
});

describe('用户列表', () => {
  it('需要登录；不含令牌哈希', async () => {
    const { app, login, sessions, index } = setup(project());
    expect((await app.request('/api/users')).status).toBe(401);
    await login('lily');
    const body = (await (await app.request('/api/users', { headers: { cookie: sessions.lily! } })).json()) as { users: Record<string, unknown>[] };
    expect(body.users.map((u) => u.name)).toEqual(['alice', 'lily']);
    expect(JSON.stringify(body)).not.toContain('tokenHash');
    index.close();
  });
});

describe('接管接口', () => {
  it('dev 接管 / 交还；产品不能接管；详情返回任务与接管', async () => {
    const store = project({ stage: 'implement' });
    mkdirSync(join(store.root, 'openspec/changes/c1'), { recursive: true });
    writeFileSync(join(store.root, 'openspec/changes/c1/tasks.md'), '- [ ] T-1 a（AC-1）\n');
    g(store.root, 'add', '-A');
    g(store.root, 'commit', '-qm', 'tasks');
    const { app, post, login, sessions, index } = setup(store);
    await login('alice');
    await login('lily');
    expect((await post('/api/changes/c1/tasks/T-1/claim', 'lily', { role: 'product' })).status).toBe(403);
    expect((await post('/api/changes/c1/tasks/T-1/claim', 'alice', { role: 'dev', note: '人来写' })).status).toBe(200);
    expect((await post('/api/changes/c1/tasks/T-1/claim', 'alice', { role: 'dev' })).status).toBe(409);
    expect((await post('/api/changes/c1/tasks/T-9/claim', 'alice', { role: 'dev' })).status).toBe(404);
    const detail = (await (await app.request('/api/changes/c1', { headers: { cookie: sessions.alice! } })).json()) as Record<string, any>;
    expect(detail.tasks).toEqual([{ id: 'T-1', title: 'a（AC-1）', done: false, acRefs: ['AC-1'], dependsOn: [] }]);
    expect(detail.claims['T-1']).toMatchObject({ by: { name: 'alice', role: 'dev' }, note: '人来写' });
    expect((await post('/api/changes/c1/tasks/T-1/release', 'alice', { role: 'dev' })).status).toBe(200);
    expect(store.events().slice(-2).map((e) => e.type)).toEqual(['task.claimed', 'task.released']);
    index.close();
  });
});

describe('产物评论接口（T3.5）', () => {
  it('列出产物与评论；评论、确认解决、重新打开；文件修改后评论重新定位', async () => {
    const store = project({ stage: 'spec' });
    const spec = 'openspec/changes/c1/specs/a/spec.md';
    mkdirSync(join(store.root, 'openspec/changes/c1/specs/a'), { recursive: true });
    writeFileSync(join(store.root, spec), '### Requirement: R\n#### Scenario: [AC-1] 导入\n- THEN 成功\n');
    const { app, post, login, sessions, index } = setup(store);
    await login('alice');
    expect((await post('/api/changes/c1/comments', 'alice', { role: 'dev', path: spec, line: '3', text: 'x' })).body.error.code).toBe('bad_arg');
    expect((await post('/api/changes/c1/comments', 'alice', { role: 'dev', path: 'src/a.js', line: 1, text: 'x' })).body.error.code).toBe('bad_path');
    const added = await post('/api/changes/c1/comments', 'alice', { role: 'dev', path: spec, line: 3, text: '写具体返回值' });
    expect(added.body.comment).toMatchObject({ id: 'C-1', quote: '- THEN 成功', by: { name: 'alice' } });

    writeFileSync(join(store.root, spec), '### Requirement: R\n\n#### Scenario: [AC-1] 导入\n- THEN 成功\n');
    const view = (await (await app.request('/api/changes/c1/artifacts', { headers: { cookie: sessions.alice! } })).json()) as { files: { path: string; target: string; comments: { id: string; anchor: unknown }[] }[] };
    expect(view.files.map((f) => [f.path, f.target])).toEqual([[spec, 'spec']]);
    expect(view.files[0]!.comments[0]).toMatchObject({ id: 'C-1', anchor: { state: 'moved', line: 4 } });

    expect((await post('/api/changes/c1/comments/C-1/resolve', 'alice', { role: 'dev', note: '手工改好了' })).status).toBe(200);
    expect((await post('/api/changes/c1/comments/C-1/reopen', 'alice', { role: 'dev' })).body.error.code).toBe('missing_arg');
    expect((await post('/api/changes/c1/comments/C-1/reopen', 'alice', { role: 'dev', note: '还是不对' })).status).toBe(200);
    expect(store.events().filter((e) => e.type.startsWith('comment.')).map((e) => e.type)).toEqual(['comment.added', 'comment.resolved', 'comment.reopened']);
    expect(store.outOfBand('c1')).toBeUndefined();
    index.close();
  });
});
