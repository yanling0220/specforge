import type {
  Change, ForgeEvent, GateEvaluation, GateId, NotificationDemand, NotificationRecipients, NotificationRecord,
  NotificationResult, NotificationRoute, NotificationScope, NotificationStatus, Question, ReviewRecord, UserRegistry,
} from '@specforge/shared';
import { ForgeError } from './errors.ts';
import { evaluateReview } from './gates.ts';
import { hashOf } from './hash.ts';
import { upstreamGates } from './pipeline.ts';
import { currentRevision, isResolved, missingRoles } from './questions.ts';

export function notificationKey(demand: NotificationDemand): string {
  return hashOf(demand);
}

/** 只计算当前事实，不读取索引、事件类型或 agent 的就绪声明。 */
export function notificationDemands(input: {
  scope: NotificationScope; change: Change; questions: Question[]; reviews: ReviewRecord[];
  gates: Partial<Record<GateId, GateEvaluation>>; headSha: string; now: string;
}): NotificationDemand[] {
  const { scope, change, questions, reviews, gates, headSha, now } = input;
  if (change.stage === 'delivered') return [];
  const base = { scope, changeId: change.id, ruleVersion: 1 as const };
  const demands: NotificationDemand[] = questions.flatMap((question) => {
    const revision = currentRevision(question);
    if (isResolved(question) || question.status !== 'drafted' || revision?.state !== 'pending') return [];
    return missingRoles(question).flatMap((role) => role === 'agent' ? [] : [{
      ...base, kind: 'question-confirmation' as const, questionId: question.id,
      rev: revision.rev, answerHash: revision.hash, role,
    }]);
  });
  const passed = (gate: GateEvaluation | undefined) => gate?.status === 'passed' && gate.checks.length > 0 && gate.checks.every((check) => check.passed);
  const verification = gates.G6A;
  if (change.stage === 'closing'
    && upstreamGates('closing', change.tier).every((id) => passed(gates[id]))
    && passed(verification) && verification?.boundTo.kind === 'commit' && verification.boundTo.value === headSha
    && evaluateReview(headSha, reviews, now).checks.find((check) => check.id === 'agent-review')?.passed
    && !reviews.some((review) => review.kind === 'human' && review.sha === headSha)) {
    demands.push({ ...base, kind: 'human-signoff', sha: headSha, role: 'dev' });
  }
  return demands;
}

/** 显式映射与当前角色取交集；不推断身份、不回退广播。 */
export function notificationRecipients(role: 'dev' | 'product', registry: UserRegistry, route?: NotificationRoute): NotificationRecipients {
  if (!route) return { ok: false, routeId: null, reason: 'no_route' };
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(route.id) || route.provider !== 'feishu' || !route.revision.trim()) {
    return { ok: false, routeId: null, reason: 'invalid_mapping' };
  }
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const member of route.members) {
    // 成员标识的渠道专用校验由适配层补充；这里先拒绝广播、空值和歧义绑定。
    if (!member.name || !/^[A-Za-z0-9_-]{1,128}$/.test(member.memberId) || member.memberId.toLowerCase() === 'all'
      || names.has(member.name) || ids.has(member.memberId)) return { ok: false, routeId: route.id, reason: 'invalid_mapping' };
    names.add(member.name);
    ids.add(member.memberId);
  }
  const members = route.members.filter((member) => registry.users.some((user) => user.name === member.name && !user.disabled && user.roles.includes(role)))
    .map((member) => ({ ...member })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (!members.length) return { ok: false, routeId: route.id, reason: 'no_recipients' };
  return { ok: true, routeId: route.id, members, fingerprint: hashOf({ routeId: route.id, provider: route.provider, revision: route.revision, role, members }) };
}

export function queueNotification(demand: NotificationDemand, recipients: NotificationRecipients, source: NotificationRecord['source'], now: string): NotificationRecord {
  return {
    version: 1, key: notificationKey(demand), demand, routeId: recipients.routeId,
    recipientsHash: recipients.ok ? recipients.fingerprint : null, source,
    status: recipients.ok ? 'queued' : 'blocked', attempts: 0, updatedAt: now,
    ...(!recipients.ok ? { reason: recipients.reason } : {}),
  };
}

export function reconcileNotification(record: NotificationRecord, recipients: NotificationRecipients | undefined, now: string): NotificationRecord {
  if (['accepted', 'started', 'unknown'].includes(record.status)) return record;
  if (!recipients) {
    if (record.status === 'cancelled') return record;
    return { ...record, status: 'cancelled', cancelledFrom: record.status as NotificationRecord['cancelledFrom'], reason: 'demand_resolved', updatedAt: now };
  }
  if (record.status === 'cancelled') {
    if (record.cancelledFrom !== 'queued' && record.cancelledFrom !== 'retry_wait') return record;
    const { cancelledFrom, reason, ...rest } = record;
    return reconcileNotification({ ...rest, status: cancelledFrom, updatedAt: now }, recipients, now);
  }
  if (record.status === 'blocked' || record.status === 'failed') return record;
  if (!recipients.ok || recipients.fingerprint !== record.recipientsHash || recipients.routeId !== record.routeId) {
    return { ...record, status: 'blocked', reason: 'recipient_changed', updatedAt: now };
  }
  return record;
}

export function startNotification(record: NotificationRecord, now: string): NotificationRecord | undefined {
  if (!['queued', 'retry_wait'].includes(record.status) || (record.nextAttemptAt && Date.parse(now) < Date.parse(record.nextAttemptAt))) return undefined;
  if (record.attempts >= notificationAttemptLimit(record)) return undefined;
  const { reason, nextAttemptAt, ...rest } = record;
  return { ...rest, status: 'started', attempts: record.attempts + 1, updatedAt: now };
}

export function notificationAttemptLimit(record: NotificationRecord): number {
  return (record.retry?.afterAttempts ?? 0) + 5;
}

/** 调用者须先校验管理员和当前需求；纯转换保留累计次数，不发送消息。 */
export function retryNotification(record: NotificationRecord, recipients: NotificationRecipients, source: NotificationRecord['source'], now: string): NotificationRecord {
  if (!['blocked', 'failed', 'unknown'].includes(record.status)
    && !(record.status === 'cancelled' && ['blocked', 'failed'].includes(record.cancelledFrom!))) {
    throw new ForgeError('notification_conflict', '只有暂停、失败或未知结果的通知可以显式重试，已受理通知不能重发');
  }
  if (!recipients.ok) throw new ForgeError('notification_blocked', '当前通知配置或接收映射不可用');
  if (record.attempts > Number.MAX_SAFE_INTEGER - 5 || (record.retry?.round ?? 0) >= Number.MAX_SAFE_INTEGER) {
    throw new ForgeError('notification_conflict', '通知累计预算已达到上限');
  }
  const { reason, nextAttemptAt, cancelledFrom, ...rest } = record;
  return {
    ...rest, routeId: recipients.routeId, recipientsHash: recipients.fingerprint, source,
    status: 'queued', updatedAt: now, retry: { round: (record.retry?.round ?? 0) + 1, afterAttempts: record.attempts },
  };
}

export function finishNotification(record: NotificationRecord, result: NotificationResult, now: string): NotificationRecord {
  if (record.status !== 'started') throw new ForgeError('notification_conflict', '通知没有进行中的发送尝试');
  if (result.kind === 'retry' && (!Number.isFinite(Date.parse(result.retryAt)) || Date.parse(result.retryAt) <= Date.parse(now))) {
    throw new ForgeError('bad_arg', '重试时间必须晚于当前时间');
  }
  const exhausted = result.kind === 'retry' && record.attempts >= notificationAttemptLimit(record);
  return {
    ...record, status: exhausted ? 'failed' : result.kind === 'retry' ? 'retry_wait' : result.kind, updatedAt: now,
    ...(result.kind === 'retry' && !exhausted ? { nextAttemptAt: result.retryAt } : {}),
    ...(exhausted ? { reason: 'retry_exhausted' as const } : result.kind === 'failed' ? { reason: 'delivery_failed' as const } : {}),
  };
}

const statuses: NotificationStatus[] = ['queued', 'started', 'accepted', 'retry_wait', 'blocked', 'failed', 'unknown', 'cancelled'];
const reasons = ['no_route', 'no_recipients', 'invalid_mapping', 'recipient_changed', 'configuration', 'demand_resolved', 'interrupted', 'delivery_failed', 'retry_exhausted'];
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const changeId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\\/%\x00-\x1f]/.test(value) && !['.', '..'].includes(value);
const time = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const invalid = (): never => { throw new ForgeError('notification_invalid', '通知账本格式或迁移版本不受支持，拒绝发送'); };

/** 同时校验版本、允许字段与来源绑定，不能静默跳过不认识的发送历史。 */
function readRecord(value: unknown): NotificationRecord {
  const record = value as NotificationRecord | undefined;
  if (!record || record.version !== 1 || !hash(record.key) || !record.demand || !record.source
    || !statuses.includes(record.status) || !Number.isSafeInteger(record.attempts) || record.attempts < 0
    || (record.retry !== undefined && (!record.retry || !Number.isSafeInteger(record.retry.round) || record.retry.round < 1
      || !Number.isSafeInteger(record.retry.afterAttempts) || record.retry.afterAttempts < 0
      || record.retry.afterAttempts > Number.MAX_SAFE_INTEGER - 5 || record.retry.afterAttempts > record.attempts))
    || record.attempts > notificationAttemptLimit(record)
    || !time(record.updatedAt) || !Number.isSafeInteger(record.source.seq) || record.source.seq < 1 || !hash(record.source.hash)
    || (record.routeId !== null && !id(record.routeId)) || (record.recipientsHash !== null && !hash(record.recipientsHash))
    || (record.reason !== undefined && !reasons.includes(record.reason))
    || (record.nextAttemptAt !== undefined && !time(record.nextAttemptAt))
    || (record.cancelledFrom !== undefined && !['queued', 'retry_wait', 'blocked', 'failed'].includes(record.cancelledFrom))) return invalid();
  const demand = record.demand;
  if (!demand.scope || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(demand.scope.projectId) || !hash(demand.scope.repositoryId)
    || !changeId(demand.changeId) || demand.ruleVersion !== 1 || !['dev', 'product'].includes(demand.role)) return invalid();
  const base = { scope: { projectId: demand.scope.projectId, repositoryId: demand.scope.repositoryId }, changeId: demand.changeId, ruleVersion: 1 as const };
  let cleanDemand: NotificationDemand;
  if (demand.kind === 'question-confirmation' && /^Q-[1-9]\d*$/.test(demand.questionId) && Number.isSafeInteger(demand.rev) && demand.rev >= 1 && hash(demand.answerHash)) {
    cleanDemand = { ...base, kind: demand.kind, questionId: demand.questionId, rev: demand.rev, answerHash: demand.answerHash, role: demand.role };
  } else if (demand.kind === 'human-signoff' && demand.role === 'dev' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(demand.sha)) {
    cleanDemand = { ...base, kind: demand.kind, sha: demand.sha, role: 'dev' };
  } else return invalid();
  const clean: NotificationRecord = {
    version: 1, key: notificationKey(cleanDemand), demand: cleanDemand,
    routeId: record.routeId, recipientsHash: record.recipientsHash,
    source: { seq: record.source.seq, hash: record.source.hash }, status: record.status, attempts: record.attempts, updatedAt: record.updatedAt,
    ...(record.retry !== undefined ? { retry: { round: record.retry.round, afterAttempts: record.retry.afterAttempts } } : {}),
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
    ...(record.nextAttemptAt !== undefined ? { nextAttemptAt: record.nextAttemptAt } : {}),
    ...(record.cancelledFrom !== undefined ? { cancelledFrom: record.cancelledFrom } : {}),
  };
  if (hashOf(clean) !== hashOf(record)
    || (record.status === 'cancelled') !== (record.cancelledFrom !== undefined)
    || (['started', 'accepted', 'retry_wait', 'failed', 'unknown'].includes(record.status) && record.attempts < 1)
    || (record.status === 'retry_wait' && (!record.nextAttemptAt || record.attempts >= notificationAttemptLimit(record)))
    || (['queued', 'started', 'accepted', 'retry_wait', 'failed', 'unknown'].includes(record.status) && (!record.routeId || !record.recipientsHash))) return invalid();
  return clean;
}

export function projectNotifications(events: ForgeEvent[], scope: NotificationScope): NotificationRecord[] {
  const records = new Map<string, NotificationRecord>();
  for (const event of events) {
    if (!event.type.startsWith('notification.')) continue;
    const record = readRecord(event.payload.record);
    const manualRetry = event.type === 'notification.retried';
    const fields = manualRetry ? ['version', 'record', 'reason', 'acceptDuplicateRisk'] : ['version', 'record'];
    if (event.payload.version !== 1 || Object.keys(event.payload).some((key) => !fields.includes(key))
      || (!manualRetry && event.type !== `notification.${record.status}`) || event.changeId !== record.demand.changeId
      || record.source.seq >= event.seq || events[record.source.seq - 1]?.hash !== record.source.hash) return invalid();
    if (hashOf(record.demand.scope) !== hashOf(scope)) throw new ForgeError('notification_binding', '通知项目或仓库身份已改变，需要显式迁移');
    const previous = records.get(record.key);
    if (manualRetry) {
      if (!previous || !['dev', 'product'].includes(event.actor.role)
        || typeof event.payload.reason !== 'string' || !event.payload.reason.trim() || event.payload.reason.length > 500
        || typeof event.payload.acceptDuplicateRisk !== 'boolean'
        || (previous.status === 'unknown' && event.payload.acceptDuplicateRisk !== true)) return invalid();
      try {
        const expected = retryNotification(previous, { ok: true, routeId: record.routeId!, fingerprint: record.recipientsHash!, members: [] }, record.source, record.updatedAt);
        if (record.status !== 'queued' || hashOf(expected) !== hashOf(record)) return invalid();
      } catch { return invalid(); }
      records.set(record.key, record);
      continue;
    }
    const transitions: Record<NotificationStatus, NotificationStatus[]> = {
      queued: ['started', 'blocked', 'cancelled'], retry_wait: ['started', 'blocked', 'cancelled'],
      started: ['accepted', 'retry_wait', 'failed', 'unknown'], blocked: ['cancelled'], failed: ['cancelled'],
      cancelled: ['queued', 'retry_wait', 'blocked'], accepted: [], unknown: [],
    };
    if ((!previous && (!['queued', 'blocked'].includes(record.status) || record.attempts !== 0 || record.retry !== undefined))
      || (previous && (hashOf(previous.demand) !== hashOf(record.demand)
        || !transitions[previous.status].includes(record.status)
        || record.attempts !== previous.attempts + (record.status === 'started' ? 1 : 0)
        || hashOf(record.retry ?? null) !== hashOf(previous.retry ?? null)
        || (record.status === 'cancelled' && record.cancelledFrom !== previous.status)
        || (previous.status === 'cancelled' && !['queued', 'retry_wait'].includes(previous.cancelledFrom!))
        || record.routeId !== previous.routeId || record.recipientsHash !== previous.recipientsHash
        || hashOf(record.source) !== hashOf(previous.source)))) return invalid();
    records.set(record.key, record);
  }
  return [...records.values()];
}
