import type { Actor, Change, ProjectConfig, ReviewRecord, TaskClaim } from '@specforge/shared';
import { ForgeError } from './errors.ts';

// 打回与修复轮次（设计文档 2.2）：收尾阶段审查不通过时，带着阻塞问题回到实现阶段；
// 超过最大修复轮次后升级给人，不再自动打回。

export const DEFAULT_MAX_FIX_ROUNDS = 3;

export function maxFixRounds(config: ProjectConfig): number {
  const n = config.workflow?.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS;
  if (!Number.isInteger(n) || n < 0) throw new ForgeError('bad_config', `workflow.maxFixRounds 必须是非负整数，收到 ${n}`);
  return n;
}

/** 尚未处理的修复轮次：最后一轮，且还没有 resolvedSha */
export function openFixRound(change: Change) {
  const last = change.fixRounds?.at(-1);
  return last && !last.resolvedSha ? last : undefined;
}

export type ReviewOutcome = { kind: 'none' } | { kind: 'sent-back'; round: number } | { kind: 'escalated'; rounds: number };

/**
 * 审查记录写入后的流程决定：只在 closing 阶段、结论为 fail、且尚未升级时生效。
 * 返回新的 change 与结果说明；不需要处理时原样返回。
 */
export function applyReviewOutcome(change: Change, record: ReviewRecord, max: number, now: string): { change: Change; outcome: ReviewOutcome } {
  if (change.stage !== 'closing' || record.verdict !== 'fail' || change.escalation) return { change, outcome: { kind: 'none' } };
  const rounds = change.fixRounds ?? [];
  if (rounds.length >= max) {
    const reason = `审查不通过，已达到最大修复轮次（${max}）`;
    return { change: { ...change, escalation: { at: now, reason, rounds: rounds.length } }, outcome: { kind: 'escalated', rounds: rounds.length } };
  }
  const round = rounds.length + 1;
  return {
    change: {
      ...change,
      stage: 'implement',
      fixRounds: [
        ...rounds,
        {
          round,
          sha: record.sha,
          source: record.kind,
          reviewer: record.reviewer,
          findings: record.findings.filter((f) => f.severity === 'blocking'),
          note: record.note,
          at: now,
        },
      ],
    },
    outcome: { kind: 'sent-back', round },
  };
}

/**
 * 离开实现阶段时结清修复轮次：必须在打回之后有新的提交，否则拒绝。
 * 没有未处理的轮次时原样返回。
 */
export function resolveFixRound(change: Change, headSha: string): Change {
  const open = openFixRound(change);
  if (!open) return change;
  if (open.sha === headSha) {
    throw new ForgeError('fix_pending', `第 ${open.round} 轮修复还没有新的提交（打回时的 commit 是 ${open.sha.slice(0, 7)}）：请运行 sf agent implement 或手工修复后提交`);
  }
  return { ...change, fixRounds: change.fixRounds!.map((r) => (r === open ? { ...r, resolvedSha: headSha } : r)) };
}

// ---------------- 接管：任务由人接手实现 ----------------

/** 当前有效的接管：任务编号 → 接管记录 */
export function activeClaims(change: Change): Map<string, TaskClaim> {
  const out = new Map<string, TaskClaim>();
  for (const c of change.taskClaims ?? []) {
    if (c.released) out.delete(c.taskId);
    else out.set(c.taskId, c);
  }
  return out;
}

/** 由人接手实现某个任务；需要 dev 角色，任务必须存在且未完成、未被接管 */
export function claimTask(change: Change, task: { id: string; done: boolean } | undefined, actor: Actor, now: string, note?: string): Change {
  if (actor.role !== 'dev') throw new ForgeError('bad_role', '接手实现任务需要 dev 角色');
  if (change.stage !== 'tasks' && change.stage !== 'implement') throw new ForgeError('bad_stage', `只能在任务或实现阶段接管任务，当前是 ${change.stage}`);
  if (!task) throw new ForgeError('not_found', '任务不存在');
  if (task.done) throw new ForgeError('done', `任务 ${task.id} 已完成`);
  const cur = activeClaims(change).get(task.id);
  if (cur) throw new ForgeError('claimed', `任务 ${task.id} 已由 ${cur.by.name} 接手`);
  return { ...change, taskClaims: [...(change.taskClaims ?? []), { taskId: task.id, by: actor, at: now, ...(note ? { note } : {}) }] };
}

/** 交还给 agent：接管人本人可以直接交还，其他 dev 必须写原因 */
export function releaseTask(change: Change, taskId: string, actor: Actor, now: string, reason?: string): Change {
  if (actor.role !== 'dev') throw new ForgeError('bad_role', '交还任务需要 dev 角色');
  const cur = activeClaims(change).get(taskId);
  if (!cur) throw new ForgeError('not_claimed', `任务 ${taskId} 没有被接管`);
  if (cur.by.name !== actor.name && !reason?.trim()) throw new ForgeError('reason_required', `任务 ${taskId} 由 ${cur.by.name} 接手，其他人交还必须写原因`);
  const claims = change.taskClaims!.map((c) => (c === cur ? { ...c, released: { by: actor, at: now, ...(reason ? { reason } : {}) } } : c));
  return { ...change, taskClaims: claims };
}
