import { applyReviewOutcome, maxFixRounds } from '@specforge/core';
import type { Actor, ReviewRecord } from '@specforge/shared';
import type { Store } from './store.ts';

/**
 * 写入审查记录，并按结论推进流程：收尾阶段不通过时打回实现阶段（开启新的修复轮次），
 * 修复轮次用尽则升级给人。两步各写一条事件，都经过 Store.mutate。
 */
export function recordReview(store: Store, changeId: string, actor: Actor, record: ReviewRecord, extra: Record<string, unknown>, log: (l: string) => void): void {
  store.mutate(changeId, actor, 'review.recorded', (s) => ({ ...s, reviews: [...s.reviews, record] }), () => ({ ...record, ...extra }));
  const max = maxFixRounds(store.config());
  const { outcome } = applyReviewOutcome(store.load(changeId).change, record, max, new Date().toISOString());
  if (outcome.kind === 'none') return;
  const next = store.mutate(
    changeId,
    actor,
    outcome.kind === 'sent-back' ? 'stage.sent_back' : 'change.escalated',
    (s) => ({ ...s, change: applyReviewOutcome(s.change, record, max, new Date().toISOString()).change }),
    (s) => (outcome.kind === 'sent-back' ? { from: 'closing', to: 'implement', fixRound: s.change.fixRounds!.at(-1) } : { ...s.change.escalation, maxFixRounds: max }),
  );
  if (outcome.kind === 'sent-back') {
    log(`↩️  审查不通过：打回实现阶段，第 ${outcome.round}/${max} 轮修复（${next.change.fixRounds!.at(-1)!.findings.length} 个阻塞问题）`);
    log(`下一步：sf agent implement ${changeId}（或手工修复并提交），然后 sf advance ${changeId}`);
  } else {
    log(`⚠️  审查不通过，修复轮次已用尽（${outcome.rounds}/${max}）：已升级给人处理，不再自动打回，实现 agent 不再运行`);
  }
}
