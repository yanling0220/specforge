import {
  addAssumption,
  createQuestion,
  ForgeError,
  nextQuestionId,
  setDimension,
  setNodes,
  setRestatement,
} from '@specforge/core';
import type { Actor, Analysis, ProjectConfig, Question, ReviewRecord, Stage } from '@specforge/shared';
import type { AnalysisDraft } from './analyst.ts';
import type { ReviewDraft } from './reviewer.ts';

export interface AppliedAnalysis {
  analysis: Analysis;
  questions: Question[];
  /** 草稿编号 D-n → 正式编号 Q-n */
  idMap: Record<string, string>;
  restatementChanged: boolean;
  skippedDimensions: string[];
}

/**
 * 把分析草稿合并进当前状态（增量）：
 * - 已确认的复述不被覆盖（agent 的新版本只在未确认时生效）
 * - 人已经下过结论的维度不被覆盖
 * - 问题与假设只追加
 */
export function applyAnalysisDraft(
  analysis: Analysis,
  questions: Question[],
  draft: AnalysisDraft,
  config: ProjectConfig,
  agent: Actor,
  stage: Stage,
  now: string,
): AppliedAnalysis {
  if (!draft.finished) throw new ForgeError('unfinished', 'agent 没有调用 finish_analysis，分析结果不完整，未写入');
  let a = analysis;
  let restatementChanged = false;
  if (draft.restatement && !a.restatement?.confirmation && draft.restatement !== a.restatement?.text) {
    a = setRestatement(a, draft.restatement);
    restatementChanged = true;
  }
  if (draft.nodes.length) a = setNodes(a, draft.nodes);
  for (const text of draft.assumptions) a = addAssumption(a, text);

  const idMap: Record<string, string> = {};
  let qs = [...questions];
  draft.questions.forEach((dq, i) => {
    const id = nextQuestionId(qs);
    idMap[`D-${i + 1}`] = id;
    const dependsOn = dq.dependsOn.map((d) => idMap[d] ?? d);
    qs = [...qs, createQuestion({ ...dq, id, dependsOn, raisedAtStage: stage }, config, agent, now)];
  });

  const skippedDimensions: string[] = [];
  for (const d of draft.dimensions) {
    const current = a.dimensions.find((x) => x.dimension === d.dimension);
    if (current && current.status !== 'pending') {
      skippedDimensions.push(d.dimension);
      continue;
    }
    const questionIds = (d.draftQuestionIds ?? []).map((id) => idMap[id] ?? id);
    a = setDimension(a, d.dimension, d.status, { reason: d.reason, questionIds });
  }
  return { analysis: a, questions: qs, idMap, restatementChanged, skippedDimensions };
}

export function reviewRecordFromDraft(draft: ReviewDraft, sha: string, reviewer: Actor, now: string): ReviewRecord {
  if (!draft.submitted || !draft.verdict) throw new ForgeError('no_review', 'agent 没有提交审查结论（submit_review），未记录');
  return {
    kind: 'agent',
    sha,
    verdict: draft.verdict,
    reviewer,
    at: now,
    coverage: draft.coverage,
    findings: draft.findings,
    note: draft.summary,
  };
}
