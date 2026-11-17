import { describe, expect, it } from 'vitest';
import type { Change, GateEvaluation, GateId, NotificationDemand, NotificationRoute, ProjectConfig, ReviewRecord, UserRegistry } from '@specforge/shared';
import {
  addUser, chainEvent, confirmAnswer, createQuestion, deferQuestion, emptyRegistry, finishNotification, invalidateQuestion,
  notificationDemands, notificationKey, notificationRecipients, projectNotifications, proposeAnswer, queueNotification,
  reconcileNotification, rejectAnswer, requireRole, retryNotification, notificationAttemptLimit, startNotification, upstreamGates,
} from '../src/index.ts';

const now = '2026-11-16T00:00:00.000Z';
const later = '2026-11-16T00:00:10.000Z';
const dev = { name: 'dev', role: 'dev' as const };
const product = { name: 'pm', role: 'product' as const };
const scope = { projectId: 'alpha', repositoryId: 'a'.repeat(64) };
const sha = 'b'.repeat(40);
const config = { confirmPolicy: { default: ['dev', 'product'] } } as ProjectConfig;
const change: Change = { id: 'same', title: '机密标题', tier: 'S', stage: 'analysis', baseSha: sha, createdAt: now, createdBy: dev };
const question = () => createQuestion({ id: 'Q-1', category: 'x', severity: 'minor', question: '机密问题', raisedAtStage: 'analysis' }, config, dev, now);
const drafted = () => proposeAnswer(question(), { text: '机密答案' }, dev, now);
const agentReview = (over: Partial<ReviewRecord> = {}): ReviewRecord => ({ kind: 'agent', sha, verdict: 'pass', reviewer: { name: 'reviewer', role: 'agent' }, at: now, coverage: ['AC-1'], findings: [], ...over });
const gate = (id: GateId): GateEvaluation => ({ gate: id, status: 'passed', checks: [{ id: 'check', label: 'check', passed: true }], boundTo: { kind: id === 'G6A' ? 'commit' : 'content', value: sha }, evaluatedAt: now });
const input = () => ({ scope, change, questions: [drafted()], reviews: [] as ReviewRecord[], gates: {} as Partial<Record<GateId, GateEvaluation>>, headSha: sha, now });
const ready = (tier: Change['tier'] = 'S') => ({
  ...input(), change: { ...change, tier, stage: 'closing' as const }, questions: [], reviews: [agentReview()],
  gates: Object.fromEntries([...upstreamGates('closing', tier), 'G6A' as const].map((id) => [id, gate(id)])),
});
const route: NotificationRoute = { id: 'team', provider: 'feishu', revision: 'v1', members: [{ name: 'dev', memberId: 'ou_dev' }, { name: 'pm', memberId: 'ou_pm' }] };
function registry(): UserRegistry {
  let users = addUser(emptyRegistry(), { name: 'dev', roles: ['dev'], admin: true }, 'token', undefined, now);
  users = addUser(users, { name: 'pm', roles: ['product'] }, 'token', dev, now);
  return users;
}

describe('通知需求与接收人（T45-AC-01～03）', () => {
  it('只提醒已有答案缺少的角色；回答者已自动确认，任一同角色确认即结束', () => {
    expect(notificationDemands({ ...input(), questions: [question()] })).toEqual([]);
    const demands = notificationDemands(input());
    expect(demands).toHaveLength(1);
    expect(demands[0]).toMatchObject({ kind: 'question-confirmation', role: 'product', questionId: 'Q-1', rev: 1 });
    const confirmed = confirmAnswer(drafted(), {}, { ...product, name: 'another-pm' }, now);
    expect(notificationDemands({ ...input(), questions: [confirmed] })).toEqual([]);
    expect(JSON.stringify(demands)).not.toMatch(/机密/);
  });

  it('驳回、推迟、作废、已交付不提醒；后续阶段回流仍提醒，不通知 agent', () => {
    for (const closed of [rejectAnswer(drafted(), '不同意', product, now), deferQuestion(drafted(), '稍后', dev, now), invalidateQuestion(drafted(), '无效', dev, now)]) {
      expect(notificationDemands({ ...input(), questions: [closed] })).toEqual([]);
    }
    expect(notificationDemands({ ...input(), change: { ...change, stage: 'delivered' } })).toEqual([]);
    expect(notificationDemands({ ...input(), change: { ...change, stage: 'implement' } })).toHaveLength(1);
    expect(notificationDemands({ ...input(), questions: [{ ...drafted(), requiredRoles: ['dev', 'product', 'agent'] }] }).map((demand) => demand.role)).toEqual(['product']);
  });

  it('同文新修订不同键，同修订追加角色创建缺少角色的需求', () => {
    const old = notificationDemands(input())[0]!;
    const revised = proposeAnswer(drafted(), { text: '机密答案' }, dev, later);
    const fresh = notificationDemands({ ...input(), questions: [revised] })[0]!;
    expect(fresh.kind === 'question-confirmation' && fresh.answerHash).toBe(old.kind === 'question-confirmation' && old.answerHash);
    expect(notificationKey(fresh)).not.toBe(notificationKey(old));
    const single = proposeAnswer({ ...question(), requiredRoles: ['dev'] }, { text: '机密答案' }, dev, now);
    const reopened = requireRole(single, 'product', '涉及业务');
    expect(reopened.revisions[0]!.rev).toBe(1);
    expect(notificationDemands({ ...input(), questions: [reopened] })[0]).toEqual(old);
  });

  it('项目、仓库、角色、change、答案版本分别参与键，不能用短 SHA 或文本代替', () => {
    const demand = notificationDemands(input())[0]!;
    const variants: NotificationDemand[] = [
      demand, { ...demand, scope: { ...scope, projectId: 'beta' } }, { ...demand, scope: { ...scope, repositoryId: 'c'.repeat(64) } },
      { ...demand, changeId: 'other' }, { ...demand, role: 'dev' },
    ];
    expect(new Set(variants.map(notificationKey)).size).toBe(variants.length);
    const a = notificationDemands(ready())[0]!;
    const b = { ...a, sha: sha.slice(0, 7) + 'c'.repeat(33) } as NotificationDemand;
    expect(notificationKey(a)).not.toBe(notificationKey(b));
  });

  it('S/M/L 必须上游与 G6A 均有通过的检查、当前 SHA 的独立审查通过后才催签', () => {
    for (const tier of ['S', 'M', 'L'] as const) {
      const facts = ready(tier);
      expect(notificationDemands(facts)).toMatchObject([{ kind: 'human-signoff', role: 'dev', sha }]);
      for (const id of [...upstreamGates('closing', tier), 'G6A' as const]) {
        expect(notificationDemands({ ...facts, gates: { ...facts.gates, [id]: undefined } })).toEqual([]);
        expect(notificationDemands({ ...facts, gates: { ...facts.gates, [id]: { ...gate(id), checks: [] } } })).toEqual([]);
        expect(notificationDemands({ ...facts, gates: { ...facts.gates, [id]: { ...gate(id), status: 'failed' } } })).toEqual([]);
      }
    }
    const facts = ready();
    expect(notificationDemands({ ...facts, gates: { ...facts.gates, G6A: { ...gate('G6A'), boundTo: { kind: 'commit', value: 'old' } } } })).toEqual([]);
    for (const reviews of [[], [agentReview({ coverage: [] })], [agentReview({ verdict: 'fail' })], [agentReview({ sha: 'old' })], [agentReview({ findings: [{ severity: 'blocking', text: '漏做', anchor: 'AC-1' }] })]]) {
      expect(notificationDemands({ ...facts, reviews })).toEqual([]);
    }
  });

  it('当前 SHA 签字 pass/fail 均不催，旧 SHA 无效，打回不催；升级新 SHA 就绪后可催', () => {
    for (const verdict of ['pass', 'fail'] as const) {
      expect(notificationDemands({ ...ready(), reviews: [agentReview(), agentReview({ kind: 'human', reviewer: dev, verdict })] })).toEqual([]);
    }
    expect(notificationDemands({ ...ready(), reviews: [agentReview(), agentReview({ kind: 'human', reviewer: dev, sha: 'old' })] })).toHaveLength(1);
    expect(notificationDemands({ ...ready(), change: { ...change, stage: 'implement' } })).toEqual([]);
    expect(notificationDemands({ ...ready(), change: { ...change, stage: 'closing', escalation: { at: now, reason: '用尽', rounds: 3 } } })).toHaveLength(1);
    expect(notificationDemands({ ...ready(), reviews: [agentReview(), agentReview({ verdict: 'fail' })] })).toEqual([]);
  });

  it('只取显式配置、有效角色与未停用成员；管理员不是 dev 的替代角色', () => {
    const reg = registry();
    reg.users.push({ ...reg.users[1]!, name: 'unmapped', roles: ['dev', 'product'] });
    expect(notificationRecipients('product', reg, route)).toMatchObject({ ok: true, members: [{ name: 'pm', memberId: 'ou_pm' }] });
    const disabled = { ...reg, users: reg.users.map((user) => user.name === 'pm' ? { ...user, disabled: { at: now, by: 'dev', reason: '离职' } } : user) };
    expect(notificationRecipients('product', disabled, route)).toMatchObject({ ok: false, reason: 'no_recipients' });
    expect(notificationRecipients('dev', { ...reg, users: [{ ...reg.users[1]!, admin: true }] }, route)).toMatchObject({ ok: false, reason: 'no_recipients' });
    expect(notificationRecipients('dev', reg)).toMatchObject({ ok: false, reason: 'no_route' });
  });

  it('接收快照不随配置排序或令牌变化漂移；成员、目标修订变化会失效，广播和歧义映射被拒绝', () => {
    const expected = notificationRecipients('product', registry(), route);
    expect(notificationRecipients('product', registry(), { ...route, members: [...route.members].reverse() })).toEqual(expected);
    const reg = registry(); reg.users[1]!.tokenHash = 'rotated';
    expect(notificationRecipients('product', reg, route)).toEqual(expected);
    expect(notificationRecipients('product', reg, { ...route, revision: 'v2' })).not.toEqual(expected);
    for (const members of [[{ name: 'pm', memberId: 'all' }], [...route.members, route.members[0]!], [{ name: 'dev', memberId: 'same' }, { name: 'pm', memberId: 'same' }]]) {
      expect(notificationRecipients('product', reg, { ...route, members })).toMatchObject({ ok: false, reason: 'invalid_mapping' });
    }
  });
});

describe('通知投影和有界尝试', () => {
  const demand = notificationDemands(input())[0]!;
  const source = chainEvent(undefined, { type: 'change.created', actor: dev, changeId: change.id, payload: {} }, now);
  const queued = () => queueNotification(demand, notificationRecipients('product', registry(), route), { seq: source.seq, hash: source.hash }, now);

  it('显式重试申请一轮五次预算并保留累计次数，已受理不能重发', () => {
    const selection = notificationRecipients('product', registry(), route);
    const failed = { ...queued(), status: 'failed' as const, attempts: 4, reason: 'delivery_failed' as const };
    const retried = retryNotification(failed, selection, failed.source, later);
    expect(retried).toMatchObject({ status: 'queued', attempts: 4, retry: { round: 1, afterAttempts: 4 } });
    expect(notificationAttemptLimit(retried)).toBe(9);
    expect(startNotification(retried, later)!.attempts).toBe(5);
    const exhausted = finishNotification({ ...retried, status: 'started', attempts: 9 }, { kind: 'retry', retryAt: '2026-11-16T00:01:00.000Z' }, later);
    expect(exhausted).toMatchObject({ status: 'failed', reason: 'retry_exhausted', attempts: 9 });
    expect(startNotification(exhausted, later)).toBeUndefined();
    expect(() => retryNotification({ ...failed, status: 'accepted' }, selection, failed.source, later)).toThrow(/已受理/);
  });

  it('重建严格校验管理员重试事件、重复风险确认及预算起点，不能借普通事件重置预算', () => {
    const events = [source];
    const append = (record: ReturnType<typeof queued>) => {
      const event = chainEvent(events.at(-1), { type: 'notification.' + record.status, actor: dev, changeId: change.id, payload: { version: 1, record } }, now);
      events.push(event);
      return event;
    };
    const record = queued();
    append(record);
    const started = startNotification(record, now)!; append(started);
    const unknown = finishNotification(started, { kind: 'unknown' }, now); const last = append(unknown);
    const retried = retryNotification(unknown, notificationRecipients('product', registry(), route), { seq: last.seq, hash: last.hash }, later);
    const event = chainEvent(last, {
      type: 'notification.retried', actor: dev, changeId: change.id,
      payload: { version: 1, record: retried, reason: '已核对外部结果', acceptDuplicateRisk: true },
    }, later);
    expect(projectNotifications([...events, event], scope)).toEqual([retried]);
    for (const bad of [
      { ...event, payload: { ...event.payload, acceptDuplicateRisk: false } },
      { ...event, payload: { version: 1, record: retried, acceptDuplicateRisk: true } },
      { ...event, actor: { name: 'engine', role: 'agent' as const } },
      { ...event, payload: { ...event.payload, record: { ...retried, retry: { round: 1, afterAttempts: 0 } } } },
      { ...event, type: 'notification.queued', payload: { version: 1, record: retried } },
    ]) expect(() => projectNotifications([...events, bad], scope)).toThrow(/账本/);
  });

  it('取消后同键恢复保留安全重试预算；成功、未知、配置失败不能自动复活', () => {
    const selection = notificationRecipients('product', registry(), route);
    const waiting = finishNotification(startNotification(queued(), now)!, { kind: 'retry', retryAt: later }, now);
    const cancelled = reconcileNotification(waiting, undefined, now);
    expect(reconcileNotification(cancelled, selection, now)).toMatchObject({ status: 'retry_wait', attempts: 1, nextAttemptAt: later });
    expect(startNotification(waiting, now)).toBeUndefined();
    expect(startNotification(waiting, later)).toMatchObject({ status: 'started', attempts: 2 });
    for (const kind of ['accepted', 'unknown', 'failed'] as const) {
      const terminal = finishNotification(startNotification(queued(), now)!, { kind }, now);
      const restored = reconcileNotification(reconcileNotification(terminal, undefined, now), selection, later);
      expect(startNotification(restored, later)).toBeUndefined();
    }
    const changed = reconcileNotification(queued(), notificationRecipients('product', registry(), { ...route, revision: 'changed' }), now);
    expect(changed).toMatchObject({ status: 'blocked', reason: 'recipient_changed' });
    expect(reconcileNotification(changed, selection, later)).toBe(changed);
  });

  it('最多五次尝试，耗尽后失败；错误结果或不合理重试时间不能写入', () => {
    let record = queued();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const at = new Date(Date.parse(now) + attempt * 20_000).toISOString();
      const next = new Date(Date.parse(at) + 10_000).toISOString();
      record = finishNotification(startNotification(record, at)!, { kind: 'retry', retryAt: next }, at);
    }
    expect(record).toMatchObject({ status: 'failed', attempts: 5, reason: 'retry_exhausted' });
    expect(startNotification(record, later)).toBeUndefined();
    expect(() => finishNotification(queued(), { kind: 'accepted' }, now)).toThrow(/进行中/);
    expect(() => finishNotification(startNotification(queued(), now)!, { kind: 'retry', retryAt: now }, now)).toThrow(/晚于/);
  });

  it('重建幂等且校验版本、项目绑定、来源和状态；不能静默忽略未知发送历史', () => {
    const record = queued();
    const event = chainEvent(source, { type: 'notification.queued', actor: dev, changeId: change.id, payload: { version: 1, record } }, now);
    expect(projectNotifications([source, event], scope)).toEqual([record]);
    expect(() => projectNotifications([source, event], { ...scope, projectId: 'other' })).toThrow(/显式迁移/);
    for (const bad of [
      { ...record, version: 2 }, { ...record, key: 'f'.repeat(64) }, { ...record, rawResponse: 'secret' },
      { ...record, source: { ...record.source, hash: 'f'.repeat(64) } }, { ...record, status: 'accepted' },
    ]) {
      expect(() => projectNotifications([source, { ...event, payload: { version: 1, record: bad } }], scope)).toThrow(/账本/);
    }
    const accepted = finishNotification(startNotification(record, now)!, { kind: 'accepted' }, now);
    expect(() => projectNotifications([source, event, { ...event, seq: 3, type: 'notification.accepted', payload: { version: 1, record: accepted } }], scope)).toThrow(/账本/);
  });
});
