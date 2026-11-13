import { describe, expect, it } from 'vitest';
import type { ForgeEvent, GateEvaluation, Question, RequirementNode } from '@specforge/shared';
import type { ChangeRow, EvidenceEntry, GatesResponse } from '../src/api.ts';
import { attentionReasons, boardColumns, buildTree, eventCategory, eventSummary, evidenceForGate, href, orderedGates, parseRoute, pipelineSteps, questionHistory, sortQuestions } from '../src/model.ts';

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

describe('需求分析视图（T3.3）', () => {
  const actor = { name: 'yan', role: 'dev' as const };
  const q = (id: string, over: Partial<Question> = {}): Question => ({
    id,
    category: '业务规则',
    severity: 'important',
    question: `${id}？`,
    options: [],
    requiredRoles: ['dev'],
    status: 'open',
    dependsOn: [],
    raisedAtStage: 'analysis',
    raisedBy: actor,
    raisedAt: '2026-11-13T01:00:00Z',
    revisions: [],
    ...over,
  });
  const nodes: RequirementNode[] = [
    { id: 'N-1', kind: 'goal', title: '批量导入' },
    { id: 'N-2', parentId: 'N-1', kind: 'feature', title: '解析 CSV' },
    { id: 'N-3', parentId: 'N-2', kind: 'scenario', title: '表头缺列' },
    { id: 'N-4', parentId: 'N-9', kind: 'feature', title: '父节点不存在' },
    { id: 'N-5', parentId: 'N-6', kind: 'scenario', title: '环 A' },
    { id: 'N-6', parentId: 'N-5', kind: 'scenario', title: '环 B' },
  ];

  it('组装分解树：问题挂到节点，阻塞数向上累加；父节点不存在的当作根；没有节点的问题单列', () => {
    const qs = [q('Q-1', { nodeId: 'N-3', severity: 'blocking' }), q('Q-2', { nodeId: 'N-2', severity: 'blocking', status: 'confirmed' }), q('Q-3'), q('Q-4', { nodeId: 'N-404' })];
    const { roots, orphans } = buildTree(nodes, qs);
    expect(roots.map((r) => r.node.id)).toEqual(['N-1', 'N-4']);
    expect(roots[0]!.openBlocking).toBe(1);
    expect(roots[0]!.children[0]!.questions.map((x) => x.id)).toEqual(['Q-2']);
    expect(roots[0]!.children[0]!.children[0]!.questions.map((x) => x.id)).toEqual(['Q-1']);
    expect(orphans.map((x) => x.id)).toEqual(['Q-3', 'Q-4']);
  });

  it('问题排序：未解决在前，再按严重程度和编号', () => {
    const qs = [q('Q-10', { severity: 'minor' }), q('Q-2', { severity: 'blocking', status: 'confirmed' }), q('Q-3', { severity: 'blocking' }), q('Q-1')];
    expect(sortQuestions(qs).map((x) => x.id)).toEqual(['Q-3', 'Q-1', 'Q-10', 'Q-2']);
  });

  it('核对历史：提出、各版本答案、确认（含代录渠道）、驳回、关闭，按时间排序', () => {
    const product = { name: 'lily', role: 'product' as const };
    const h = questionHistory(
      q('Q-1', {
        status: 'deferred',
        revisions: [
          { rev: 1, text: '一律 member', optionId: 'A', proposedBy: actor, proposedAt: '2026-11-13T02:00:00Z', state: 'rejected', confirmations: [], rejection: { actor: product, at: '2026-11-13T03:00:00Z', note: '要问运营' }, hash: 'a' },
          {
            rev: 2,
            text: '一律 member，admin 走审批',
            reason: '运营要求',
            proposedBy: actor,
            proposedAt: '2026-11-13T04:00:00Z',
            state: 'confirmed',
            confirmations: [{ role: 'product', actor: product, at: '2026-11-13T05:00:00Z', via: '会议纪要', recordedBy: actor }],
            hash: 'b',
          },
        ],
        closure: { kind: 'deferred', actor, at: '2026-11-13T06:00:00Z', reason: '下期' },
      }),
    );
    expect(h.map((x) => `${x.kind}:${x.rev ?? ''}`)).toEqual(['raised:', 'proposed:1', 'rejected:1', 'proposed:2', 'confirmed:2', 'deferred:']);
    expect(h[1]!.text).toBe('选 A：一律 member');
    expect(h[3]!.text).toContain('修改原因：运营要求');
    expect(h[4]).toMatchObject({ actor: product, recordedBy: actor, via: '会议纪要' });
  });

  it('需求分析路由（可深链接到问题）', () => {
    for (const r of [{ page: 'change', id: 'c1', tab: 'analysis' }, { page: 'change', id: 'c1', tab: 'analysis', qid: 'Q-2' }] as const) expect(parseRoute(href(r))).toEqual(r);
  });
});
