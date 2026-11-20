import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createQuestion, disableUser } from '@specforge/core';
import type { QuestionWorkDetail, QuestionWorkPage } from '@specforge/shared';
import { questionAction, verifyLog } from '@specforge/store';
import { createApp } from '../src/app.ts';
import { ForgeIndex } from '../src/index-db.ts';
import { indexActor as dev } from './fixtures/index-project.ts';
import { notificationProject } from './fixtures/notification-project.ts';

const pm = { name: 'pm', role: 'product' as const };
const path = '/api/changes/same/questions/Q-1';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

async function setup() {
  const store = notificationProject();
  const index = new ForgeIndex(store);
  cleanup.push(() => { index.close(); rmSync(store.root, { recursive: true, force: true }); });
  const app = createApp(store, index);
  async function login(name: string) {
    const response = await app.request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, token: name + '-token' }),
    });
    expect(response.status).toBe(200);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  }
  const devCookie = await login('dev');
  const pmCookie = await login('pm');
  const get = (url: string, cookie = pmCookie) => app.request(url, { headers: { cookie } });
  const detail = async (role = 'product', cookie = role === 'dev' ? devCookie : pmCookie) => {
    const response = await get(path + '?role=' + role, cookie);
    expect(response.status).toBe(200);
    return await response.json() as QuestionWorkDetail;
  };
  const post = (action: string, body: object, cookie = pmCookie) => app.request(path + '/' + action, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'product', ...body }),
  });
  const page = async (query = 'role=product', cookie = pmCookie) => {
    const response = await get('/api/question-work?' + query, cookie);
    expect(response.status).toBe(200);
    return await response.json() as QuestionWorkPage;
  };
  return { store, detail, devCookie, pmCookie, get, post, page, login };
}

describe('问题工作台', () => {
  it('按所需角色和当前修订筛选，退回进入待修订，已交付只读', async () => {
    const { store, detail, devCookie, pmCookie, get, page, post, login } = await setup();
    expect((await get('/api/question-work?role=product', '')).status).toBe(401);
    expect((await get('/api/question-work?role=product&name=pm', devCookie)).status).toBe(403);
    expect((await get(path + '?role=dev', pmCookie)).status).toBe(403);
    const before = store.events();
    expect((await page()).items).toMatchObject([{ status: 'confirm', answer: { text: 'private-answer' } }]);
    expect((await page('role=dev', devCookie)).items).toMatchObject([{ status: 'waiting', missingRoles: ['product'] }]);
    const read = await detail();
    expect(read.draftScope).not.toBe(pmCookie.split('=')[1]);
    expect((await detail()).draftScope).toBe(read.draftScope);
    expect((await detail('product', await login('pm'))).draftScope).not.toBe(read.draftScope);
    expect(await (await get(path)).json()).toEqual(read.question);
    expect(store.events()).toEqual(before);
    questionAction(store, 'same', pm, 'Q-1', { kind: 'reject', note: '需说明影响' });
    expect((await page()).items).toMatchObject([{ status: 'revise', answer: { text: 'private-answer', rejection: '需说明影响' }, missingRoles: [] }]);
    store.mutate('same', dev, 'stage.advanced', (s) => ({ ...s, change: { ...s.change, stage: 'delivered' } }), () => ({}));
    const delivered = await detail();
    expect(delivered.actions).toEqual([]);
    expect((await page()).items).toEqual([]);
    const submission = { mode: 'free', text: '编辑', baseQuestionVersion: read.questionVersion };
    expect(await (await post('submit-answer', submission)).json()).toMatchObject({ error: { code: 'stale_question' } });
    expect((await post('submit-answer', { ...submission, baseQuestionVersion: delivered.questionVersion })).status).toBe(403);
    store.mutateUsers(dev, 'user.disabled', (r) => disableUser(r, 'pm', '停用', dev, 'T'), {});
    expect((await get(path + '?role=product')).status).toBe(401);
  });

  it('首次并发提交只写一次，标准选项以服务端正文生成，同内容新版本仍然冲突', async () => {
    const { store, detail, post } = await setup();
    store.mutate('same', dev, 'question.raised', (s) => ({ ...s, questions: [{
      ...s.questions[0]!, revisions: [], status: 'open', options: [{ id: 'a', text: '标准正文' }],
    }] }), () => ({}));
    const basis = await detail();
    const body = { mode: 'option', optionId: 'a', supplement: ' 附加内容 ', text: '忽略客户端正文', baseQuestionVersion: basis.questionVersion };
    const before = store.events().length;
    const responses = await Promise.all([post('submit-answer', body), post('submit-answer', body)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = await responses.find((r) => r.status === 409)!.json() as { error: { code: string } };
    expect(['write_busy', 'stale_question']).toContain(loser.error.code);
    expect(await (await post('submit-answer', body)).json()).toMatchObject({ error: { code: 'stale_question' } });
    const next = await detail();
    expect(next.question.revisions).toMatchObject([{ rev: 1, text: '标准正文\n\n附加内容', confirmations: [{ role: 'product' }] }]);
    expect(store.events().slice(before)).toMatchObject([{ type: 'question.answered', payload: { rev: 1, answerHash: next.question.revisions[0]!.hash } }]);
    const current = next.question.revisions[0]!;
    questionAction(store, 'same', pm, 'Q-1', { kind: 'answer', text: current.text, optionId: current.optionId });
    expect(await (await post('submit-answer', { ...body, baseQuestionVersion: next.questionVersion })).json()).toMatchObject({ error: { code: 'stale_question' } });
    expect(await (await post('confirm', { rev: current.rev, answerHash: current.hash, baseQuestionVersion: next.questionVersion })).json()).toMatchObject({ error: { code: 'stale_answer' } });
    expect(verifyLog(store).ok).toBe(true);
  });

  it('同版确认、退回和追加角色都会使旧基准失效', async () => {
    const { store, detail, post, devCookie } = await setup();
    const stale = async (basis: QuestionWorkDetail) => {
      const events = store.events();
      const response = await post('submit-answer', { mode: 'free', text: '我的修订', baseQuestionVersion: basis.questionVersion });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'stale_question' } });
      expect(store.events()).toEqual(events);
    };
    const initial = await detail();
    questionAction(store, 'same', pm, 'Q-1', { kind: 'confirm' });
    await stale(initial);
    questionAction(store, 'same', dev, 'Q-1', { kind: 'answer', text: '第二版', reason: '补充' });
    const pending = await detail();
    questionAction(store, 'same', pm, 'Q-1', { kind: 'reject', note: '仍需补充' });
    await stale(pending);
    const rejected = await detail();
    store.mutate('same', dev, 'question.role_required', (s) => ({ ...s, questions: s.questions.map((q) => ({
      ...q, requiredRoles: [...q.requiredRoles, 'agent'],
    })) }), () => ({ role: 'agent' }));
    await stale(rejected);
    const current = await detail();
    const r = current.question.revisions.at(-1)!;
    expect(await (await post('reject', { rev: r.rev, answerHash: r.hash, note: '过期', baseQuestionVersion: pending.questionVersion })).json()).toMatchObject({ error: { code: 'stale_question' } });
    expect((await detail('dev', devCookie)).status).toBe('revise');
    expect(verifyLog(store).ok).toBe(true);
  });

  it('工作列表限页、截断摘要，游标受角色、项目和结果版本约束', async () => {
    const { store, get, page, devCookie } = await setup();
    store.mutate('same', dev, 'question.raised', (s) => ({ ...s, questions: [...s.questions, ...Array.from({ length: 52 }, (_, i) => createQuestion({
      id: 'Q-' + (i + 2), question: '长问题'.repeat(500), severity: i === 51 ? 'blocking' : 'minor', category: '业务规则', raisedAtStage: 'analysis',
    }, store.config(), dev, 'T'))] }), () => ({}));
    const first = await page('role=product&status=answer');
    expect(first.counts).toEqual({ answer: 52, revise: 0, confirm: 1, waiting: 0 });
    expect(first.items).toHaveLength(50);
    expect(first.items[0]).toMatchObject({ questionId: 'Q-53', severity: 'blocking' });
    expect(first.items[0]!.question).toHaveLength(280);
    const cursor = '&cursor=' + first.nextCursor;
    expect((await page('role=product&status=answer' + cursor)).items).toHaveLength(2);
    expect((await get('/api/question-work?role=dev&status=answer' + cursor, devCookie)).status).toBe(409);
    expect((await get('/api/question-work?role=product' + cursor)).status).toBe(409);
    const other = await setup();
    expect((await other.get('/api/question-work?role=product&status=answer' + cursor)).status).toBe(409);
    questionAction(store, 'same', dev, 'Q-53', { kind: 'answer', text: '最新答案' });
    expect(await (await get('/api/question-work?role=product&status=answer' + cursor)).json()).toMatchObject({ error: { code: 'stale_cursor' } });
  });
});
