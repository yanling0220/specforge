import type { GateEvaluation, GateId, Stage, Tier } from '@specforge/shared';
import { ForgeError } from './errors.ts';

// 第一期的阶段与出口门禁。G3/G4/G5 在第二期加入 implement 之前的 design / tasks 阶段。
const EXIT_GATE: Partial<Record<Stage, GateId>> = {
  analysis: 'G1',
  spec: 'G2',
  closing: 'G6',
};

export function stagesFor(tier: Tier): Stage[] {
  return tier === 'S'
    ? ['analysis', 'implement', 'closing', 'delivered']
    : ['analysis', 'spec', 'implement', 'closing', 'delivered'];
}

/** 离开某阶段前必须仍然有效的门禁：该阶段及其之前所有阶段的出口门禁 */
export function gatesRequiredToLeave(stage: Stage, tier: Tier): GateId[] {
  const path = stagesFor(tier);
  const idx = path.indexOf(stage);
  return path.slice(0, idx + 1).flatMap((s) => (EXIT_GATE[s] ? [EXIT_GATE[s]] : []));
}

/** 进入当前阶段所依赖的上游门禁（用于发现"上游失效"） */
export function upstreamGates(stage: Stage, tier: Tier): GateId[] {
  const path = stagesFor(tier);
  const idx = path.indexOf(stage);
  return path.slice(0, idx).flatMap((s) => (EXIT_GATE[s] ? [EXIT_GATE[s]] : []));
}

/**
 * 推进到下一阶段。evaluations 必须是调用方此刻重新评估的结果，不能用缓存。
 * 只要有一道门未通过就拒绝（P2：只有引擎能推进流程）。
 */
export function nextStage(stage: Stage, tier: Tier, evaluations: Partial<Record<GateId, GateEvaluation>>): Stage {
  const path = stagesFor(tier);
  const idx = path.indexOf(stage);
  if (idx < 0) throw new ForgeError('bad_stage', `阶段 ${stage} 不属于 ${tier} 档流程`);
  if (idx === path.length - 1) throw new ForgeError('done', '已经是最后一个阶段');
  const blocked = gatesRequiredToLeave(stage, tier).filter((g) => evaluations[g]?.status !== 'passed');
  if (blocked.length) {
    throw new ForgeError('gate_blocked', `门禁未通过：${blocked.join(', ')}`);
  }
  return path[idx + 1]!;
}
