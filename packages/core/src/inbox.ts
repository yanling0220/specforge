import type { Change, GateEvaluation, GateId, HumanDecision, HumanRole, InboxItem, Question, ReviewRecord } from '@specforge/shared';
import { evaluateReview } from './gates.ts';
import { hashOf } from './hash.ts';
import { stagesFor, upstreamGates } from './pipeline.ts';
import { currentRevision, isResolved, missingRoles } from './questions.ts';

export interface HumanDecisionFacts {
  change: Change;
  questions: Question[];
  reviews: ReviewRecord[];
  gates: Partial<Record<GateId, GateEvaluation>>;
  headSha: string;
  now: string;
}

/** 与 IM 通知共用当前答案和签字就绪规则，渠道配置不参与人工待办判定。 */
export function pendingConfirmations(questions: Question[]): Extract<HumanDecision, { kind: 'question-confirmation' }>[] {
  return questions.flatMap((question) => {
    const revision = currentRevision(question);
    if (isResolved(question) || question.status !== 'drafted' || revision?.state !== 'pending') return [];
    return missingRoles(question).flatMap((role) => role === 'agent' ? [] : [{
      kind: 'question-confirmation' as const, questionId: question.id, rev: revision.rev, answerHash: revision.hash, role,
    }]);
  });
}

const passed = (gate: GateEvaluation | undefined) => gate?.status === 'passed'
  && gate.checks.length > 0 && gate.checks.every((check) => check.passed);

export function humanSignoffReady({ change, gates, headSha, reviews, now }: HumanDecisionFacts): boolean {
  const verification = gates.G6A;
  return change.stage === 'closing'
    && upstreamGates('closing', change.tier).every((id) => passed(gates[id]))
    && passed(verification) && verification?.boundTo.kind === 'commit' && verification.boundTo.value === headSha
    && !!evaluateReview(headSha, reviews, now).checks.find((check) => check.id === 'agent-review')?.passed
    && !reviews.some((review) => review.kind === 'human' && review.sha === headSha);
}

/** 必须已有合格材料，仅缺人工审批；空门禁、评论或结构错误都不能当成就绪。 */
function approvalReady(gate: GateEvaluation | undefined): gate is GateEvaluation {
  return !!gate && gate.boundTo.kind === 'content'
    && gate.checks.some((check) => check.id === 'approved' && !check.passed)
    && gate.checks.some((check) => check.id !== 'approved')
    && gate.checks.every((check) => check.id === 'approved' || check.passed);
}

export function inboxItems(facts: HumanDecisionFacts, role: HumanRole): InboxItem[] {
  const { change, gates } = facts;
  if (change.stage === 'delivered') return [];
  const decisions: HumanDecision[] = pendingConfirmations(facts.questions).filter((item) => item.role === role);
  if (role === 'dev') {
    const stages = stagesFor(change.tier);
    for (const [stage, gateId, kind] of [['spec', 'G2', 'spec-approval'], ['design', 'G3', 'design-approval']] as const) {
      const gate = gates[gateId];
      // 已进入过的审批阶段允许因内容变化再次审批；不提前列出未来阶段的待办。
      if (stages.includes(stage) && stages.indexOf(change.stage) >= stages.indexOf(stage)
        && upstreamGates(stage, change.tier).every((id) => passed(gates[id])) && approvalReady(gate)) {
        decisions.push({ kind, role: 'dev', contentHash: gate.boundTo.value });
      }
    }
    if (humanSignoffReady(facts)) decisions.push({ kind: 'human-signoff', role: 'dev', sha: facts.headSha });
  }
  return decisions.map((decision) => ({
    ...decision, id: hashOf({ changeId: change.id, ...decision }),
    changeId: change.id, changeTitle: change.title, stage: change.stage,
  }));
}
