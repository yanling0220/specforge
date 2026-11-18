import { describe, expect, it } from 'vitest';
import type { Change, GateEvaluation, GateId, ProjectConfig, ReviewRecord } from '@specforge/shared';
import {
  confirmAnswer, createQuestion, deferQuestion, inboxItems, invalidateQuestion, proposeAnswer, rejectAnswer,
  upstreamGates, type HumanDecisionFacts,
} from '../src/index.ts';

const now = '2026-11-18T00:00:00.000Z';
const sha = 'a'.repeat(40);
const dev = { name: 'dev', role: 'dev' as const };
const pm = { name: 'pm', role: 'product' as const };
const config = { confirmPolicy: { default: ['dev', 'product'] } } as ProjectConfig;
const change: Change = { id: 'same', title: '示例', tier: 'M', stage: 'spec', baseSha: sha, createdAt: now, createdBy: dev };
const question = () => createQuestion({ id: 'Q-1', category: 'x', severity: 'minor', question: '问题', raisedAtStage: 'analysis' }, config, dev, now);
const drafted = () => proposeAnswer(question(), { text: '答案' }, dev, now);
const gate = (id: GateId): GateEvaluation => ({ gate: id, status: 'passed', checks: [{ id: 'material', label: '材料', passed: true }], boundTo: { kind: id === 'G6A' ? 'commit' : 'content', value: sha }, evaluatedAt: now });
const approval = (id: GateId): GateEvaluation => ({ ...gate(id), status: 'failed', checks: [...gate(id).checks, { id: 'approved', label: '审批', passed: false }] });
const facts = (): HumanDecisionFacts => ({ change, questions: [], reviews: [], gates: { G1: gate('G1'), G2: approval('G2') }, headSha: sha, now });

describe('审批收件箱（T4.6）', () => {
  it('只列缺少角色的当前答案，确认、同文修订和角色切换后立即重算', () => {
    const input = { ...facts(), change: { ...change, stage: 'analysis' as const }, questions: [drafted()] };
    const item = inboxItems(input, 'product')[0]!;
    expect(item).toMatchObject({ kind: 'question-confirmation', questionId: 'Q-1', rev: 1, role: 'product' });
    expect(inboxItems(input, 'dev')).toEqual([]);
    expect(inboxItems({ ...input, questions: [confirmAnswer(drafted(), {}, pm, now)] }, 'product')).toEqual([]);
    const next = proposeAnswer(drafted(), { text: '答案' }, dev, now);
    const fresh = inboxItems({ ...input, questions: [next] }, 'product')[0]!;
    expect(fresh.id).not.toBe(item.id);
    expect(fresh).toMatchObject({ rev: 2, answerHash: 'answerHash' in item ? item.answerHash : '' });
  });

  it('未回答、驳回、推迟、作废不列待确认；后续回流仍列，已交付不列', () => {
    for (const q of [question(), rejectAnswer(drafted(), '不同意', pm, now), deferQuestion(drafted(), '后续', dev, now), invalidateQuestion(drafted(), '不适用', dev, now)]) {
      expect(inboxItems({ ...facts(), questions: [q] }, 'product')).toEqual([]);
    }
    expect(inboxItems({ ...facts(), change: { ...change, stage: 'implement' }, questions: [drafted()] }, 'product')).toHaveLength(1);
    expect(inboxItems({ ...facts(), change: { ...change, stage: 'delivered' }, questions: [drafted()] }, 'product')).toEqual([]);
    const agentOnly = { ...drafted(), requiredRoles: ['agent' as const] };
    expect(inboxItems({ ...facts(), questions: [agentOnly] }, 'product')).toEqual([]);
  });

  it('规格审批仅在已进入规格阶段、G1 通过且其他检查就绪时列给 dev', () => {
    expect(inboxItems(facts(), 'dev')).toMatchObject([{ kind: 'spec-approval', contentHash: sha }]);
    expect(inboxItems(facts(), 'product')).toEqual([]);
    expect(inboxItems({ ...facts(), change: { ...change, stage: 'analysis' } }, 'dev')).toEqual([]);
    for (const g1 of [undefined, { ...gate('G1'), checks: [] }, { ...gate('G1'), status: 'failed' as const }]) {
      expect(inboxItems({ ...facts(), gates: { ...facts().gates, G1: g1 } }, 'dev')).toEqual([]);
    }
    for (const g2 of [undefined, gate('G2'), { ...approval('G2'), checks: [] }, { ...approval('G2'), checks: [{ id: 'approved', label: '审批', passed: false }] }, {
      ...approval('G2'), checks: [...approval('G2').checks, { id: 'comments', label: '未解决评论', passed: false }],
    }]) {
      expect(inboxItems({ ...facts(), gates: { G1: gate('G1'), G2: g2 } }, 'dev')).toEqual([]);
    }
  });

  it('方案审批须当前规则要求、上游全部通过；跳过的阶段不产生审批', () => {
    const input = { ...facts(), change: { ...change, tier: 'L' as const, stage: 'design' as const }, gates: { G1: gate('G1'), G2: gate('G2'), G3: approval('G3') } };
    expect(inboxItems(input, 'dev')).toMatchObject([{ kind: 'design-approval' }]);
    expect(inboxItems({ ...input, gates: { ...input.gates, G2: approval('G2') } }, 'dev')).toMatchObject([{ kind: 'spec-approval' }]);
    expect(inboxItems({ ...input, change: { ...input.change, stage: 'spec' } }, 'dev')).toEqual([]);
    expect(inboxItems({ ...input, gates: { ...input.gates, G3: gate('G3') } }, 'dev')).toEqual([]);
    expect(inboxItems({ ...input, change: { ...input.change, tier: 'S', stage: 'implement' } }, 'dev')).toEqual([]);
  });

  it('审批后消失，后续阶段内容绑定改变可再次审批；ID 稳定且不依赖生成时间或标题', () => {
    const before = inboxItems(facts(), 'dev')[0]!;
    expect(inboxItems({ ...facts(), now: 'later', change: { ...change, title: '新标题' } }, 'dev')[0]!.id).toBe(before.id);
    expect(inboxItems({ ...facts(), gates: { G1: gate('G1'), G2: gate('G2') } }, 'dev')).toEqual([]);
    const updated = { ...approval('G2'), boundTo: { kind: 'content' as const, value: 'new-hash' } };
    expect(inboxItems({ ...facts(), change: { ...change, stage: 'tasks' }, gates: { G1: gate('G1'), G2: updated } }, 'dev')[0]!.id).not.toBe(before.id);
  });

  it('签字须当前 SHA 验证及独立审查就绪，仅列给 dev，空检查或旧 SHA 均不算', () => {
    for (const tier of ['S', 'M', 'L'] as const) {
      const review: ReviewRecord = { kind: 'agent', sha, verdict: 'pass', reviewer: { name: 'reviewer', role: 'agent' }, at: now, coverage: ['AC-1'], findings: [] };
      const input = { ...facts(), change: { ...change, tier, stage: 'closing' as const }, reviews: [review], gates: Object.fromEntries([...upstreamGates('closing', tier), 'G6A' as const].map((id) => [id, gate(id)])) };
      expect(inboxItems(input, 'dev')).toMatchObject([{ kind: 'human-signoff', sha }]);
      expect(inboxItems(input, 'product')).toEqual([]);
      for (const bad of [undefined, { ...gate('G6A'), checks: [] }, { ...gate('G6A'), boundTo: { kind: 'commit' as const, value: 'old-sha' } }]) {
        expect(inboxItems({ ...input, gates: { ...input.gates, G6A: bad } }, 'dev')).toEqual([]);
      }
      expect(inboxItems({ ...input, reviews: [] }, 'dev')).toEqual([]);
      expect(inboxItems({ ...input, reviews: [review, { ...review, kind: 'human', reviewer: dev }] }, 'dev')).toEqual([]);
      expect(inboxItems({ ...input, headSha: 'new-sha' }, 'dev')).toEqual([]);
    }
  });
});
