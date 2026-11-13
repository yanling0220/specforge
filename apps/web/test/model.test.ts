import { describe, expect, it } from 'vitest';
import type { ForgeEvent, GateEvaluation } from '@specforge/shared';
import type { ChangeRow, EvidenceEntry, GatesResponse } from '../src/api.ts';
import { attentionReasons, boardColumns, eventCategory, eventSummary, evidenceForGate, href, orderedGates, parseRoute, pipelineSteps } from '../src/model.ts';

const row = (over: Partial<ChangeRow>): ChangeRow => ({
  id: 'c',
  title: 't',
  tier: 'M',
  stage: 'analysis',
  createdAt: 'T',
  createdBy: 'b',
  openQuestions: 0,
  openBlocking: 0,
  fixRounds: 0,
  escalated: false,
  lastEventSeq: 1,
  lastEventAt: null,
  ...over,
});
const gate = (id: GateEvaluation['gate'], status: 'passed' | 'failed', value = 'x'): GateEvaluation => ({
  gate: id,
  status,
  checks: [],
  boundTo: { kind: id === 'G6A' ? 'commit' : 'content', value },
  evaluatedAt: 'T',
});
const ev = (over: Partial<EvidenceEntry>): EvidenceEntry => ({
  id: 'e',
  kind: 'verify',
  sha: 'sha',
  passed: true,
  seq: 1,
  at: 'T',
  actor: { name: 'b', role: 'dev' },
  hashOk: true,
  ...over,
});

describe('看板', () => {
  it('按阶段分列，列内最近活动在前', () => {
    const cols = boardColumns([row({ id: 'a', lastEventSeq: 1 }), row({ id: 'b', lastEventSeq: 5 }), row({ id: 'c', stage: 'closing' })]);
    expect(cols.map((c) => c.stage)).toEqual(['analysis', 'spec', 'design', 'tasks', 'implement', 'closing', 'delivered']);
    expect(cols[0]!.changes.map((c) => c.id)).toEqual(['b', 'a']);
    expect(cols[5]!.changes.map((c) => c.id)).toEqual(['c']);
  });

  it('等人处理的原因：升级、阻塞问题、修复轮次', () => {
    expect(attentionReasons(row({}))).toEqual([]);
    expect(attentionReasons(row({ openBlocking: 2, openQuestions: 3 }))).toEqual(['2 个阻塞问题待回答']);
    expect(attentionReasons(row({ openQuestions: 1 }))).toEqual(['1 个问题待处理']);
    expect(attentionReasons(row({ escalated: true, fixRounds: 3, stage: 'closing' }))).toEqual(['已升级给人处理']);
    expect(attentionReasons(row({ fixRounds: 1, stage: 'implement' }))).toEqual(['第 1 轮修复']);
  });
});

describe('门禁与流水线', () => {
  const g: GatesResponse = {
    stage: 'implement',
    pipeline: [
      { stage: 'analysis', exitGate: 'G1' },
      { stage: 'spec', exitGate: 'G2' },
      { stage: 'implement', exitGate: 'G5' },
      { stage: 'closing', exitGate: 'G6' },
      { stage: 'delivered' },
    ],
    gates: { G6: gate('G6', 'failed'), G1: gate('G1', 'failed'), G2: gate('G2', 'passed'), G5: gate('G5', 'failed') },
    upstreamInvalid: ['G1'],
  };

  it('阶段状态与上游失效', () => {
    expect(pipelineSteps(g).map((s) => [s.stage, s.state, s.gateStatus, s.invalidated])).toEqual([
      ['analysis', 'done', 'failed', true],
      ['spec', 'done', 'passed', false],
      ['implement', 'current', 'failed', false],
      ['closing', 'todo', 'failed', false],
      ['delivered', 'todo', undefined, false],
    ]);
  });

  it('门禁按固定顺序', () => {
    expect(orderedGates(g).map((x) => x.gate)).toEqual(['G1', 'G2', 'G5', 'G6']);
  });

  it('G6A 关联绑定 commit 的验证证据，G5 关联 TDD 证据，最新在前', () => {
    const list = [ev({ id: 'v1', sha: 'head', seq: 1 }), ev({ id: 'v0', sha: 'old', seq: 2 }), ev({ id: 'v2', sha: 'head', seq: 3 }), ev({ id: 't1', kind: 'tdd', taskId: 'T-1', seq: 4 })];
    expect(evidenceForGate(gate('G6A', 'passed', 'head'), list).map((e) => e.id)).toEqual(['v2', 'v1']);
    expect(evidenceForGate(gate('G5', 'passed'), list).map((e) => e.id)).toEqual(['t1']);
    expect(evidenceForGate(gate('G1', 'passed'), list)).toEqual([]);
  });
});

describe('事件', () => {
  const e = (type: string, payload: Record<string, unknown>): ForgeEvent => ({ type, payload, actor: { name: 'b', role: 'dev' }, seq: 1, at: 'T', prevHash: '', hash: '' });

  it('常见事件的一句话说明', () => {
    expect(eventSummary(e('stage.advanced', { from: 'tasks', to: 'implement' }))).toBe('推进：任务 → 实现');
    expect(eventSummary(e('question.raised', { questionIds: ['Q-2', 'Q-3'] }))).toBe('提出问题 Q-2, Q-3');
    expect(eventSummary(e('question.raised', { questionId: 'Q-1', question: '能否？' }))).toBe('提出问题 Q-1：能否？');
    expect(eventSummary(e('review.recorded', { kind: 'agent', verdict: 'fail', sha: 'abcdef123' }))).toBe('agent 审查：不通过（abcdef1）');
    expect(eventSummary(e('evidence.recorded', { sha: 'abcdef123', steps: [{ name: 'test', exitCode: 1 }] }))).toBe('验证 abcdef1：test ✗');
    expect(eventSummary(e('tdd.recorded', { taskId: 'T-1', passed: true, sha: 'abcdef123' }))).toBe('G5 T-1：先红后绿 ✓（abcdef1）');
    expect(eventSummary(e('something.new', {}))).toBe('something.new');
  });

  it('事件分类', () => {
    expect(['stage.sent_back', 'question.confirmed', 'implement.committed', 'tdd.recorded', 'spec.approved', 'state.out_of_band_acknowledged'].map(eventCategory)).toEqual([
      'stage',
      'question',
      'agent',
      'evidence',
      'review',
      'other',
    ]);
  });
});

describe('路由', () => {
  it('解析与生成互逆；未知路径回到看板', () => {
    for (const r of [
      { page: 'board' },
      { page: 'events' },
      { page: 'change', id: 'bulk-import', tab: 'gates' },
      { page: 'change', id: 'bulk-import', tab: 'timeline' },
      { page: 'evidence', id: 'c1', eid: 'ev-2026-abc' },
    ] as const) {
      expect(parseRoute(href(r))).toEqual(r);
    }
    expect(parseRoute('#/whatever')).toEqual({ page: 'board' });
    expect(parseRoute('')).toEqual({ page: 'board' });
  });
});
