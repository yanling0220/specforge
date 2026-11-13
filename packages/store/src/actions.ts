import {
  applyReviewOutcome,
  claimTask as claimTaskCore,
  checkProxySubject,
  confirmAnswer,
  confirmRestatement as confirmRestatementCore,
  decideAssumption as decideAssumptionCore,
  deferQuestion,
  ForgeError,
  invalidateQuestion,
  maxFixRounds,
  nextStage,
  proposeAnswer,
  rejectAnswer,
  releaseTask as releaseTaskCore,
  requireRole,
  resolveFixRound,
} from '@specforge/core';
import { headSha } from '@specforge/runner';
import type { Actor, Question, ReviewFinding, ReviewRecord, Role, Stage } from '@specforge/shared';
import { bindingNow, evaluateAll, factsTree, readTasksFacts } from './engine.ts';
import type { ChangeState, Store } from './store.ts';

// 人的写操作（CLI 与 server 共用）。每个操作都经过 Store.mutate 写入哈希链；
// 校验规则来自 core，这里只负责组装事件。

const now = () => new Date().toISOString();

function findQuestion(state: ChangeState, qid: string): Question {
  const q = state.questions.find((x) => x.id === qid);
  if (!q) throw new ForgeError('not_found', `问题 ${qid} 不存在`);
  return q;
}

function replaceQuestion(state: ChangeState, q: Question): ChangeState {
  return { ...state, questions: state.questions.map((x) => (x.id === q.id ? q : x)) };
}

export type QuestionOp =
  | { kind: 'answer'; text: string; optionId?: string; reason?: string; via?: string }
  | { kind: 'confirm'; onBehalfOf?: Actor; via?: string; note?: string }
  | { kind: 'reject'; note: string; onBehalfOf?: Actor }
  | { kind: 'defer'; reason: string }
  | { kind: 'invalidate'; reason: string }
  | { kind: 'require'; role: Role; reason: string };

const QUESTION_EVENT: Record<QuestionOp['kind'], string> = {
  answer: 'question.answered',
  confirm: 'question.confirmed',
  reject: 'question.rejected',
  defer: 'question.deferred',
  invalidate: 'question.invalidated',
  require: 'question.role_required',
};

/** 回答 / 确认 / 驳回 / 推迟 / 作废 / 追加确认角色 */
export function questionAction(store: Store, changeId: string, actor: Actor, qid: string, op: QuestionOp): Question {
  const proxy = op.kind === 'confirm' || op.kind === 'reject' ? op.onBehalfOf : undefined;
  if (proxy) checkProxySubject(store.users(), proxy);
  if (op.kind === 'require' && !['dev', 'product'].includes(op.role)) throw new ForgeError('bad_arg', '追加的角色只能是 dev|product');
  const t = now();
  const apply = (q: Question): Question => {
    switch (op.kind) {
      case 'answer':
        if (!op.text.trim()) throw new ForgeError('missing_arg', '答案不能为空');
        return proposeAnswer(q, { text: op.text, optionId: op.optionId, reason: op.reason, via: op.via }, actor, t);
      case 'confirm':
        return confirmAnswer(q, { onBehalfOf: op.onBehalfOf, via: op.via, note: op.note }, actor, t);
      case 'reject':
        return rejectAnswer(q, op.note, actor, t, op.onBehalfOf);
      case 'defer':
        return deferQuestion(q, op.reason, actor, t);
      case 'invalidate':
        return invalidateQuestion(q, op.reason, actor, t);
      case 'require':
        return requireRole(q, op.role, op.reason);
    }
  };
  const payload = (q: Question): Record<string, unknown> => {
    const r = q.revisions.at(-1);
    switch (op.kind) {
      case 'answer':
        return { questionId: q.id, rev: r!.rev, answerHash: r!.hash, text: r!.text, optionId: r!.optionId, reason: r!.reason, status: q.status };
      case 'confirm': {
        const c = r!.confirmations.at(-1)!;
        return { questionId: q.id, rev: r!.rev, answerHash: r!.hash, role: c.role, confirmer: c.actor, recordedBy: c.recordedBy, via: c.via, note: c.note, status: q.status };
      }
      case 'reject':
        return { questionId: q.id, rev: r!.rev, note: r!.rejection!.note, by: r!.rejection!.actor };
      case 'defer':
      case 'invalidate':
        return { questionId: q.id, reason: q.closure!.reason };
      case 'require':
        return { questionId: q.id, role: op.role, reason: op.reason, requiredRoles: q.requiredRoles, status: q.status };
    }
  };
  let updated: Question | undefined;
  store.mutate(
    changeId,
    actor,
    QUESTION_EVENT[op.kind],
    (s) => {
      updated = apply(findQuestion(s, qid));
      return replaceQuestion(s, updated);
    },
    () => payload(updated!),
  );
  return updated!;
}

export function confirmRestatement(store: Store, changeId: string, actor: Actor, via?: string): void {
  store.mutate(
    changeId,
    actor,
    'restatement.confirmed',
    (s) => ({ ...s, analysis: confirmRestatementCore(s.analysis, actor, now(), via) }),
    (s) => ({ hash: s.analysis.restatement!.hash, via }),
  );
}

export function decideAssumption(store: Store, changeId: string, actor: Actor, assumptionId: string, status: 'accepted' | 'rejected', note?: string): void {
  store.mutate(
    changeId,
    actor,
    'assumption.decided',
    (s) => ({ ...s, analysis: decideAssumptionCore(s.analysis, assumptionId, status, actor, now(), note) }),
    () => ({ assumptionId, status, note }),
  );
}

/** 审批当前版本的 spec / 方案（绑定内容哈希）；需要 dev 角色 */
export function approve(store: Store, changeId: string, actor: Actor, target: 'spec' | 'design', note?: string): string {
  if (actor.role !== 'dev') throw new ForgeError('bad_role', `${target} 审批需要 dev 角色`);
  const hash = bindingNow(store, store.load(changeId), target === 'spec' ? 'G2' : 'G3');
  if (!hash) throw new ForgeError('no_target', `S 档没有 ${target} 审批`);
  store.mutate(changeId, actor, `${target}.approved`, (s) => ({ ...s, approvals: [...s.approvals, { target, hash, actor, at: now(), note }] }), () => ({ hash, note }));
  return hash;
}

/** 推进到下一阶段：门禁此刻重新评估，不通过则记录拒绝事件并抛错 */
export function advance(store: Store, changeId: string, actor: Actor): { from: Stage; to: Stage } {
  const state = store.load(changeId);
  const evals = evaluateAll(store, state);
  let to: Stage;
  let change = state.change;
  try {
    to = nextStage(state.change.stage, state.change.tier, evals);
    if (state.change.stage === 'implement') change = resolveFixRound(state.change, headSha(store.root));
  } catch (e) {
    store.append({ type: 'stage.advance_rejected', actor, changeId, payload: { from: state.change.stage, reason: (e as Error).message } });
    throw e;
  }
  store.mutate(
    changeId,
    actor,
    'stage.advanced',
    (s) => ({ ...s, change: { ...change, stage: to } }),
    () => ({
      from: state.change.stage,
      to,
      ...(change !== state.change ? { fixRoundResolved: change.fixRounds!.at(-1) } : {}),
      gates: Object.fromEntries(Object.entries(evals).map(([g, ev]) => [g, { status: ev.status, boundTo: ev.boundTo.value }])),
    }),
  );
  return { from: state.change.stage, to };
}

/**
 * 写入审查记录，并按结论推进流程：收尾阶段不通过时打回实现阶段（开启新的修复轮次），
 * 修复轮次用尽则升级给人。两步各写一条事件，都经过 Store.mutate。
 */
export function recordReview(store: Store, changeId: string, actor: Actor, record: ReviewRecord, extra: Record<string, unknown>, log: (l: string) => void): void {
  store.mutate(changeId, actor, 'review.recorded', (s) => ({ ...s, reviews: [...s.reviews, record] }), () => ({ ...record, ...extra }));
  const max = maxFixRounds(store.config());
  const { outcome } = applyReviewOutcome(store.load(changeId).change, record, max, now());
  if (outcome.kind === 'none') return;
  const next = store.mutate(
    changeId,
    actor,
    outcome.kind === 'sent-back' ? 'stage.sent_back' : 'change.escalated',
    (s) => ({ ...s, change: applyReviewOutcome(s.change, record, max, now()).change }),
    (s) => (outcome.kind === 'sent-back' ? { from: 'closing', to: 'implement', fixRound: s.change.fixRounds!.at(-1) } : { ...s.change.escalation, maxFixRounds: max }),
  );
  if (outcome.kind === 'sent-back') {
    log(`↩️  审查不通过：打回实现阶段，第 ${outcome.round}/${max} 轮修复（${next.change.fixRounds!.at(-1)!.findings.length} 个阻塞问题）`);
    log(`下一步：sf agent implement ${changeId}（或手工修复并提交），然后 sf advance ${changeId}`);
  } else {
    log(`⚠️  审查不通过，修复轮次已用尽（${outcome.rounds}/${max}）：已升级给人处理，不再自动打回，实现 agent 不再运行`);
  }
}

/**
 * 开发者签字（G6 6B 的人工部分），绑定当前 HEAD。
 * 不通过即"打回"：附上阻塞问题（锚定 AC 或问题编号），在收尾阶段会打回实现或升级。
 */
export function signOff(
  store: Store,
  changeId: string,
  actor: Actor,
  input: { verdict: 'pass' | 'fail'; note?: string; findings?: ReviewFinding[] },
  log: (l: string) => void = () => {},
): ReviewRecord {
  if (actor.role !== 'dev') throw new ForgeError('bad_role', '开发者签字必须由 dev 角色完成');
  if (!['pass', 'fail'].includes(input.verdict)) throw new ForgeError('bad_arg', '结论只能是 pass|fail');
  if (input.verdict === 'fail' && !input.note?.trim() && !input.findings?.length) throw new ForgeError('note_required', '打回必须写明原因');
  const record: ReviewRecord = {
    kind: 'human',
    sha: headSha(store.root),
    verdict: input.verdict,
    reviewer: actor,
    at: now(),
    coverage: [],
    findings: input.findings ?? [],
    note: input.note,
  };
  recordReview(store, changeId, actor, record, {}, log);
  return record;
}

/** 接管：任务由人接手实现，实现 agent 不再处理（直到交还） */
export function claimTask(store: Store, changeId: string, actor: Actor, taskId: string, note?: string): void {
  const state = store.load(changeId);
  const task = readTasksFacts(store, changeId, factsTree(store, state))?.tasks.find((t) => t.id === taskId);
  if (!task) throw new ForgeError('not_found', `任务 ${taskId} 不在 tasks.md 中`);
  store.mutate(changeId, actor, 'task.claimed', (s) => ({ ...s, change: claimTaskCore(s.change, task, actor, now(), note) }), () => ({ taskId, note }));
}

/** 交还给 agent */
export function releaseTask(store: Store, changeId: string, actor: Actor, taskId: string, reason?: string): void {
  store.mutate(changeId, actor, 'task.released', (s) => ({ ...s, change: releaseTaskCore(s.change, taskId, actor, now(), reason) }), () => ({ taskId, reason }));
}
