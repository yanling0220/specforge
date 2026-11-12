import type { Actor, Analysis, AssumptionStatus, DimensionStatus, ProjectConfig } from '@specforge/shared';
import { ForgeError } from './errors.ts';
import { hashOf } from './hash.ts';

export function emptyAnalysis(config: ProjectConfig): Analysis {
  return {
    nodes: [],
    assumptions: [],
    dimensions: config.dimensions.map((dimension) => ({ dimension, status: 'pending' })),
  };
}

/** 设置需求复述；内容变化会清除之前的确认 */
export function setRestatement(a: Analysis, text: string): Analysis {
  if (!text.trim()) throw new ForgeError('empty', '需求复述不能为空');
  return { ...a, restatement: { text, hash: hashOf(text) } };
}

export function confirmRestatement(a: Analysis, actor: Actor, now: string, via?: string): Analysis {
  if (!a.restatement) throw new ForgeError('no_restatement', '还没有需求复述');
  const { text, hash } = a.restatement;
  return { ...a, restatement: { text, hash, confirmation: { role: actor.role, actor, at: now, via, hash } } };
}

export function addAssumption(a: Analysis, text: string): Analysis {
  const id = `A-${a.assumptions.length + 1}`;
  return { ...a, assumptions: [...a.assumptions, { id, text, status: 'pending' }] };
}

export function decideAssumption(
  a: Analysis,
  id: string,
  status: Exclude<AssumptionStatus, 'pending'>,
  actor: Actor,
  now: string,
  note?: string,
): Analysis {
  if (!a.assumptions.some((x) => x.id === id)) throw new ForgeError('not_found', `假设 ${id} 不存在`);
  return {
    ...a,
    assumptions: a.assumptions.map((x) => (x.id === id ? { ...x, status, decidedBy: actor, decidedAt: now, note } : x)),
  };
}

export function setDimension(
  a: Analysis,
  dimension: string,
  status: Exclude<DimensionStatus, 'pending'>,
  opts: { reason?: string; questionIds?: string[] } = {},
): Analysis {
  if (status === 'na' && !opts.reason?.trim()) throw new ForgeError('reason_required', '标记为不适用必须写原因');
  if (status === 'question' && !opts.questionIds?.length) {
    throw new ForgeError('question_required', '标记为 question 必须关联问题编号');
  }
  const entry = { dimension, status, reason: opts.reason, questionIds: opts.questionIds };
  const exists = a.dimensions.some((d) => d.dimension === dimension);
  return {
    ...a,
    dimensions: exists ? a.dimensions.map((d) => (d.dimension === dimension ? entry : d)) : [...a.dimensions, entry],
  };
}
