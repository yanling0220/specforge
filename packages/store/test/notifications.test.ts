import { fork } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addUser, confirmRestatement, createQuestion, disableUser, emptyAnalysis, proposeAnswer, setRestatement, sha256, updateUser } from '@specforge/core';
import { git, headSha } from '@specforge/runner';
import type { NotificationRoute, ReviewRecord } from '@specforge/shared';
import { anchorLog, defaultConfig, evaluateAll, NotificationLedger, questionAction, recordReview, signOff, Store, verifyLog } from '../src/index.ts';

const dev = { name: 'dev', role: 'dev' as const };
const pm = { name: 'pm', role: 'product' as const };
const now = '2026-11-16T00:00:00.000Z';
const later = '2026-11-16T00:01:00.000Z';
const route: NotificationRoute = { id: 'team', provider: 'feishu', revision: 'v1', members: [{ name: 'pm', memberId: 'ou_pm' }] };
const options = { projectId: 'alpha', enabled: true, route, now: () => now };
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

function project(): Store {
  const root = mkdtempSync(join(tmpdir(), 'sf-notify-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['commit', '--allow-empty', '-qm', 'init']);
  mkdirSync(join(root, '.specforge'), { recursive: true });
  const config = { ...defaultConfig(), protectedPaths: [], testGlobs: [], verify: [{ name: 'test', command: 'test' }] };
  writeFileSync(join(root, '.specforge', 'config.json'), JSON.stringify(config));
  const store = new Store(root);
  store.mutateUsers(dev, 'user.added', (reg) => addUser(reg, { name: 'dev', roles: ['dev'], admin: true }, sha256('dev-token'), undefined, now), {});
  store.mutateUsers(dev, 'user.added', (reg) => addUser(reg, { name: 'pm', roles: ['product'] }, sha256('pm-token'), dev, now), {});
  const question = createQuestion({ id: 'Q-1', question: 'private-question', category: '范围', severity: 'minor', raisedAtStage: 'analysis' }, config, dev, now);
  store.create({
    change: { id: 'same', title: 'private-title', tier: 'S', stage: 'analysis', baseSha: headSha(root), createdAt: now, createdBy: dev },
    analysis: emptyAnalysis(config), questions: [proposeAnswer(question, { text: 'private-answer' }, dev, now)], reviews: [], approvals: [],
  }, dev);
  return store;
}

const files = (store: Store) => ['change', 'analysis', 'questions', 'reviews', 'approvals'].map((name) => readFileSync(store.path('changes', 'same', `${name}.json`), 'utf8'));

function closing(store: Store): void {
  store.mutate('same', dev, 'test.ready', (state) => ({
    ...state, questions: [], change: { ...state.change, stage: 'closing' },
    analysis: confirmRestatement(setRestatement(state.analysis, 'ready'), dev, now),
  }), () => ({}));
  evidenceAndReview(store);
}

function evidenceAndReview(store: Store): void {
  const sha = headSha(store.root);
  store.saveEvidence('same', {
    id: `ev-${sha}`, sha, startedAt: now, finishedAt: now, mainTreeDirty: false,
    steps: [{ name: 'test', command: 'test', exitCode: 0, timedOut: false, durationMs: 1, outputTail: '# tests 1\n', outputHash: sha256('# tests 1\n') }],
    host: { node: 'test', platform: 'test' },
  }, dev);
  const review: ReviewRecord = { kind: 'agent', sha, verdict: 'pass', reviewer: { name: 'reviewer', role: 'agent' }, at: now, coverage: ['change'], findings: [] };
  recordReview(store, 'same', review.reviewer, review, {}, () => {});
}

describe('通知 Store 发送账本（T4.5b）', () => {
  it('默认未启用不写通知、不读凭据或发送；启用后只补当前待办，重复扫描没有事件循环', () => {
    const store = project();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const events = store.events();
    expect(new NotificationLedger(store, { projectId: 'alpha' }).reconcile()).toEqual([]);
    expect(store.events()).toEqual(events);
    const ledger = new NotificationLedger(store, options);
    const queued = ledger.reconcile();
    expect(queued).toMatchObject([{ status: 'queued', attempts: 0, demand: { role: 'product' } }]);
    const after = store.events();
    expect(ledger.reconcile()).toEqual(queued);
    expect(ledger.reconcile()).toEqual(queued);
    expect(store.events()).toEqual(after);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('假传输受理只记一次，重启从事件重建；状态文件、Git HEAD 与门禁绑定不变', () => {
    const store = project();
    const ledger = new NotificationLedger(store, options);
    const before = files(store);
    const sha = headSha(store.root);
    const gates = evaluateAll(store, store.load('same'));
    const anchor = anchorLog(store).anchor;
    const [queued] = ledger.reconcile();
    const prepared = ledger.prepare(queued!.key)!;
    expect(store.lockStatus().locked).toBe(false);
    const fakeTransport = vi.fn(() => ({ kind: 'accepted' as const }));
    ledger.finish(prepared.record.key, prepared.record.attempts, fakeTransport());
    ledger.finish(prepared.record.key, prepared.record.attempts, { kind: 'accepted' });
    const restarted = new NotificationLedger(new Store(store.root), options);
    expect(restarted.reconcile()).toMatchObject([{ status: 'accepted', attempts: 1 }]);
    expect(restarted.prepare(queued!.key)).toBeUndefined();
    expect(fakeTransport).toHaveBeenCalledTimes(1);
    expect(files(store)).toEqual(before);
    expect(headSha(store.root)).toBe(sha);
    const after = evaluateAll(store, store.load('same'));
    for (const id of Object.keys(gates) as (keyof typeof gates)[]) expect(after[id]!.boundTo).toEqual(gates[id]!.boundTo);
    expect(verifyLog(store, anchor.commit).ok).toBe(true);
    const payloads = JSON.stringify(store.events().filter((event) => event.type.startsWith('notification.')));
    expect(payloads).not.toMatch(/private-|ou_pm|pm-token|dev-token/);
    expect(prepared.members).toEqual([{ name: 'pm', memberId: 'ou_pm' }]);
  });

  it('CLI 离线修订后只补当前版本，同文新版本仍新建键；发送前确认会取消旧待办', () => {
    const store = project();
    const ledger = new NotificationLedger(store, options);
    const [old] = ledger.reconcile();
    questionAction(store, 'same', dev, 'Q-1', { kind: 'answer', text: 'private-answer' });
    const restarted = new NotificationLedger(new Store(store.root), options);
    const records = restarted.reconcile();
    expect(records.find((entry) => entry.key === old!.key)!.status).toBe('cancelled');
    const fresh = records.find((entry) => entry.status === 'queued')!;
    expect(fresh.key).not.toBe(old!.key);
    expect(fresh.demand).toMatchObject({ rev: 2 });
    questionAction(store, 'same', pm, 'Q-1', { kind: 'confirm' });
    expect(restarted.prepare(fresh.key)).toBeUndefined();
    expect(restarted.list().every((entry) => entry.status === 'cancelled')).toBe(true);
    const silent = project();
    questionAction(silent, 'same', pm, 'Q-1', { kind: 'confirm' });
    expect(new NotificationLedger(silent, options).reconcile()).toEqual([]);
  });

  it('缺少映射时 blocked；停用 / 移除角色和成员快照变化在发送前暂停，不能自动恢复', () => {
    for (const op of ['disable', 'role', 'route'] as const) {
      const store = project();
      const ledger = new NotificationLedger(store, options);
      const [record] = ledger.reconcile();
      if (op === 'disable') store.mutateUsers(dev, 'user.disabled', (reg) => disableUser(reg, 'pm', '离职', dev, now), {});
      if (op === 'role') store.mutateUsers(dev, 'user.updated', (reg) => updateUser(reg, 'pm', { roles: ['dev'] }, dev), {});
      const current = op === 'route' ? new NotificationLedger(store, { ...options, route: { ...route, revision: 'v2' } }) : ledger;
      expect(current.prepare(record!.key)).toBeUndefined();
      expect(current.list()).toMatchObject([{ status: 'blocked', reason: 'recipient_changed', attempts: 0 }]);
      expect(new NotificationLedger(store, options).prepare(record!.key)).toBeUndefined();
    }
    expect(new NotificationLedger(project(), { ...options, route: undefined }).reconcile()).toMatchObject([{ status: 'blocked', reason: 'no_route' }]);
    expect(new NotificationLedger(project(), { ...options, route: { ...route, members: [] } }).reconcile()).toMatchObject([{ status: 'blocked', reason: 'no_recipients' }]);
  });

  it('同名项目数据跨仓库不串用，改项目 ID 或复制账本到另一仓库不能静默重置去重', () => {
    const a = project(); const b = project();
    const left = new NotificationLedger(a, options).reconcile()[0]!;
    const right = new NotificationLedger(b, options).reconcile()[0]!;
    expect(left.key).not.toBe(right.key);
    expect(() => new NotificationLedger(a, { ...options, projectId: 'renamed' }).reconcile()).toThrow(/显式迁移/);
    cpSync(a.path(), b.path(), { recursive: true });
    expect(() => new NotificationLedger(b, options).reconcile()).toThrow(/显式迁移/);
    expect(new NotificationLedger(a, options).list()).toEqual([left]);
  });

  it('仓库入口被替换时失败关闭；重建实例同样不能忘记原绑定', () => {
    const store = project();
    const ledger = new NotificationLedger(store, options);
    ledger.reconcile();
    renameSync(join(store.root, '.git'), join(store.root, '.git-old'));
    git(store.root, ['init', '-q']);
    expect(() => ledger.reconcile()).toThrow(/身份已改变/);
    expect(() => new NotificationLedger(store, options).list()).toThrow(/显式迁移/);
  });

  it('状态、名册、链或已有锚定异常时拒绝创建发送账本，不用通知事件掩盖损坏', () => {
    for (const target of ['state', 'users', 'chain', 'anchor', 'config'] as const) {
      const store = project();
      const ledger = new NotificationLedger(store, options);
      if (target === 'state') writeFileSync(store.path('changes', 'same', 'questions.json'), '[]');
      if (target === 'users') writeFileSync(store.path('users.json'), '{}');
      if (target === 'chain') writeFileSync(store.path('events.jsonl'), readFileSync(store.path('events.jsonl'), 'utf8').replace('private-title', 'changed-title'));
      if (target === 'anchor') { anchorLog(store); writeFileSync(store.path('events.jsonl'), ''); }
      if (target === 'config') writeFileSync(store.path('config.json'), '{');
      expect(() => ledger.reconcile()).toThrow();
      expect(readFileSync(store.path('events.jsonl'), 'utf8')).not.toContain('notification.');
    }
  });

  it('安全重试的到期时间、次数经重启保留；过期尝试不能覆盖后来的结果', () => {
    const store = project();
    const ledger = new NotificationLedger(store, options);
    const key = ledger.reconcile()[0]!.key;
    const first = ledger.prepare(key)!;
    ledger.finish(key, first.record.attempts, { kind: 'retry', retryAt: later });
    const restart = new NotificationLedger(new Store(store.root), options);
    expect(restart.prepare(key)).toBeUndefined();
    const due = new NotificationLedger(store, { ...options, now: () => later });
    const second = due.prepare(key)!;
    expect(second.record.attempts).toBe(2);
    expect(() => due.finish(key, 1, { kind: 'accepted' })).toThrow(/尝试已变化/);
    due.finish(key, 2, { kind: 'accepted' });
    expect(due.list()[0]!.status).toBe('accepted');
  });

  it('started 后退出保守恢复为 unknown，不自动重发或伪造远端受理', () => {
    const store = project();
    const ledger = new NotificationLedger(store, options);
    const key = ledger.reconcile()[0]!.key;
    const attempt = ledger.prepare(key)!;
    const fakeTransport = vi.fn(); fakeTransport(); // 模拟远端已收到，但本地未落结果即退出。
    const restarted = new NotificationLedger(new Store(store.root), options);
    expect(restarted.recoverInterrupted()).toMatchObject([{ status: 'unknown', reason: 'interrupted', attempts: 1 }]);
    const events = store.events();
    expect(restarted.prepare(key)).toBeUndefined();
    restarted.recoverInterrupted(); restarted.reconcile();
    expect(store.events()).toEqual(events);
    expect(fakeTransport).toHaveBeenCalledTimes(1);
    expect(() => restarted.finish(key, attempt.record.attempts, { kind: 'accepted' })).toThrow(/进行中/);
  });

  it('一个项目最多一项 started；锁释放后能继续本项目写入和其他项目工作', () => {
    const store = project(); const other = project();
    const state = store.load('same');
    store.create({ ...state, change: { ...state.change, id: 'another' } }, dev);
    const ledger = new NotificationLedger(store, options);
    const records = ledger.reconcile();
    ledger.prepare(records[0]!.key);
    expect(new NotificationLedger(store, options).prepare(records[1]!.key)).toBeUndefined();
    questionAction(store, 'same', dev, 'Q-1', { kind: 'answer', text: 'new answer' });
    expect(new NotificationLedger(other, options).reconcile()).toHaveLength(1);
    expect(verifyLog(store).ok).toBe(true);
  });

  it('实际收尾门禁就绪才登记，签字取消待发；新 HEAD 重新取证和审查后产生新键', () => {
    const store = project();
    closing(store);
    const notifyOptions = { ...options, route: { ...route, members: [{ name: 'dev', memberId: 'ou_dev' }] } };
    const ledger = new NotificationLedger(store, notifyOptions);
    const first = ledger.reconcile()[0]!;
    expect(first).toMatchObject({ status: 'queued', demand: { kind: 'human-signoff', sha: headSha(store.root) } });
    const before = evaluateAll(store, store.load('same'));
    ledger.reconcile();
    const after = evaluateAll(store, store.load('same'));
    expect(after.G6A!.boundTo).toEqual(before.G6A!.boundTo);
    expect(after.G6B!.boundTo).toEqual(before.G6B!.boundTo);
    signOff(store, 'same', dev, { verdict: 'pass' });
    expect(ledger.prepare(first.key)).toBeUndefined();
    git(store.root, ['commit', '--allow-empty', '-qm', 'new-head']);
    expect(ledger.reconcile()).toMatchObject([{ status: 'cancelled' }]);
    evidenceAndReview(store);
    const fresh = ledger.reconcile().find((record) => record.status === 'queued')!;
    expect(fresh.key).not.toBe(first.key);
    expect(fresh.demand).toMatchObject({ sha: headSha(store.root) });
  });

  it('同一 SHA 暂时失去就绪后恢复，复用键与剩余预算；已发送的不会再次提醒', () => {
    const store = project(); closing(store);
    const ledger = new NotificationLedger(store, { ...options, route: { ...route, members: [{ name: 'dev', memberId: 'ou_dev' }] } });
    const key = ledger.reconcile()[0]!.key;
    const original = store.load('same').analysis;
    store.mutate('same', dev, 'test.invalidate', (state) => ({ ...state, analysis: setRestatement(state.analysis, 'changed') }), () => ({}));
    expect(ledger.reconcile()[0]!.status).toBe('cancelled');
    store.mutate('same', dev, 'test.restore', (state) => ({ ...state, analysis: original }), () => ({}));
    expect(ledger.reconcile()).toMatchObject([{ key, status: 'queued', attempts: 0 }]);
    ledger.prepare(key); ledger.finish(key, 1, { kind: 'accepted' });
    expect(ledger.reconcile()).toHaveLength(1);
    expect(ledger.prepare(key)).toBeUndefined();
  });

  it('关闭时只读预览当前待办，不登记、发送、修改业务文件或恢复历史结果', () => {
    const store = project();
    const ledger = new NotificationLedger(store, { ...options, enabled: false });
    const before = { events: store.events(), files: files(store), sha: headSha(store.root) };
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(ledger.preview()).toMatchObject([{ existing: false, record: { status: 'queued', attempts: 0 }, recipients: { ok: true } }]);
    expect(ledger.list()).toEqual([]);
    expect({ events: store.events(), files: files(store), sha: headSha(store.root) }).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('管理员重试需原因；unknown 需重复风险确认；普通成员、agent、关闭及错误配置均不能重试', () => {
    const store = project(); const ledger = new NotificationLedger(store, options);
    const key = ledger.reconcile()[0]!.key;
    ledger.prepare(key); ledger.finish(key, 1, { kind: 'unknown' });
    const before = { events: store.events(), files: files(store) };
    expect(() => ledger.retry(key, pm, { reason: '检查完成', acceptDuplicateRisk: true })).toThrow(/管理员/);
    expect(() => ledger.retry(key, { name: dev.name, role: 'agent' }, { reason: '检查完成', acceptDuplicateRisk: true })).toThrow();
    expect(() => ledger.retry(key, dev, { reason: ' ' })).toThrow(/原因/);
    expect(() => ledger.retry(key, dev, { reason: '检查完成' })).toThrow(/重复消息风险/);
    expect(() => new NotificationLedger(store, { ...options, enabled: false }).retry(key, dev, { reason: '检查完成', acceptDuplicateRisk: true })).toThrow(/已关闭/);
    expect(() => new NotificationLedger(store, { ...options, available: false }).retry(key, dev, { reason: '检查完成', acceptDuplicateRisk: true })).toThrow(/配置或接收映射/);
    expect({ events: store.events(), files: files(store) }).toEqual(before);
    expect(ledger.retry(key, dev, { reason: '已核对并接受重复风险', acceptDuplicateRisk: true })).toMatchObject({ status: 'queued', attempts: 1, retry: { round: 1, afterAttempts: 1 } });
    expect(store.events().at(-1)).toMatchObject({ type: 'notification.retried', actor: dev, payload: { reason: '已核对并接受重复风险', acceptDuplicateRisk: true } });
    expect(files(store)).toEqual(before.files);
    ledger.prepare(key); ledger.finish(key, 2, { kind: 'accepted' });
    expect(() => ledger.retry(key, dev, { reason: '再次提醒' })).toThrow(/已受理/);
    expect(verifyLog(store).ok).toBe(true);
  });

  it('显式重试每轮五次，重启保持累计次数与轮次，旧结果不能覆盖新尝试', () => {
    const store = project(); let clock = Date.parse(now);
    const currentOptions = { ...options, now: () => new Date(clock).toISOString() };
    const ledger = new NotificationLedger(store, currentOptions);
    const key = ledger.reconcile()[0]!.key;
    ledger.prepare(key); ledger.finish(key, 1, { kind: 'failed' });
    ledger.retry(key, dev, { reason: '已修复签名配置' });
    for (let attempt = 2; attempt <= 6; attempt++) {
      const restarted = new NotificationLedger(new Store(store.root), currentOptions);
      expect(restarted.prepare(key)!.record.attempts).toBe(attempt);
      const result = restarted.finish(key, attempt, { kind: 'retry', retryAt: new Date(clock + 10_000).toISOString() });
      expect(result.status).toBe(attempt === 6 ? 'failed' : 'retry_wait');
      clock += 10_000;
    }
    expect(ledger.list()).toMatchObject([{ attempts: 6, status: 'failed', reason: 'retry_exhausted', retry: { round: 1, afterAttempts: 1 } }]);
    expect(ledger.prepare(key)).toBeUndefined();
    expect(ledger.retry(key, dev, { reason: '已解除限流' })).toMatchObject({ attempts: 6, retry: { round: 2, afterAttempts: 6 } });
    ledger.prepare(key);
    expect(() => ledger.finish(key, 1, { kind: 'accepted' })).toThrow(/尝试已变化/);
    ledger.finish(key, 7, { kind: 'accepted' });
    expect(new NotificationLedger(new Store(store.root), currentOptions).list()).toMatchObject([{ status: 'accepted', attempts: 7 }]);
    expect(store.events().filter((event) => event.type === 'notification.retried')).toHaveLength(2);
    expect(verifyLog(store).ok).toBe(true);
  });

  it('管理员可显式重新绑定变更后的接收快照，旧版本结束后不能再重试', () => {
    const store = project(); const ledger = new NotificationLedger(store, options);
    const original = ledger.reconcile()[0]!;
    const changed = new NotificationLedger(store, { ...options, route: { ...route, revision: 'v2' } });
    expect(changed.reconcile()).toMatchObject([{ status: 'blocked', reason: 'recipient_changed' }]);
    const rebound = changed.retry(original.key, dev, { reason: '已核对新群和接收成员' });
    expect(rebound.key).toBe(original.key);
    expect(rebound.recipientsHash).not.toBe(original.recipientsHash);
    expect(rebound.source.seq).toBeGreaterThan(original.source.seq);
    expect(changed.preview()).toMatchObject([{ existing: true, record: { status: 'queued' } }]);
    questionAction(store, 'same', pm, 'Q-1', { kind: 'confirm' });
    const before = store.events();
    expect(() => changed.retry(original.key, dev, { reason: '旧消息' })).toThrow(/待办已经失效/);
    expect(store.events()).toEqual(before);
    expect(verifyLog(store).ok).toBe(true);
  });

  it('两个真实进程同时登记同一需求，只有一条 queued、序号连续且状态一致', async () => {
    const store = project();
    const worker = join(import.meta.dirname, 'fixtures/notification-writer.ts');
    const children = [fork(worker, [store.root], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }), fork(worker, [store.root], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })];
    try {
      const runs = children.map((child) => {
        let error = ''; child.stderr!.on('data', (chunk) => { error += chunk; });
        const exited = once(child, 'exit');
        const ready = Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`worker 提前退出 ${error}`); })]);
        return { ready, done: exited.then(([code, signal]) => { expect({ code, signal, error }).toEqual({ code: 0, signal: null, error: '' }); }) };
      });
      await Promise.all(runs.map((run) => run.ready));
      children.forEach((child) => child.send('go'));
      await Promise.all(runs.map((run) => run.done));
      expect(store.events().filter((event) => event.type === 'notification.queued')).toHaveLength(1);
      expect(new NotificationLedger(store, options).list()).toHaveLength(1);
      expect(verifyLog(store).ok).toBe(true);
    } finally {
      await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map(async (child) => { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }));
    }
  });
});
