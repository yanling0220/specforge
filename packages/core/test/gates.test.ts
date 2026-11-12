import { describe, expect, it } from 'vitest';
import type { Actor, Analysis, ProjectConfig, Question, VerificationEvidence } from '@specforge/shared';
import {
  addAssumption,
  confirmRestatement,
  createQuestion,
  decideAssumption,
  evaluateReview,
  evaluateSpec,
  evaluateTwin,
  evaluateUnderstanding,
  evaluateVerification,
  isStillValid,
  nextStage,
  parseSpec,
  proposeAnswer,
  setDimension,
  setRestatement,
  understandingBinding,
} from '../src/index.ts';

const dev: Actor = { name: 'yan', role: 'dev' };
const T = '2026-11-12T10:00:00Z';
const config = { confirmPolicy: { default: ['dev'] } } as unknown as ProjectConfig;

function readyAnalysis(): Analysis {
  let a: Analysis = { nodes: [], assumptions: [], dimensions: [{ dimension: '性能', status: 'pending' }] };
  a = confirmRestatement(setRestatement(a, '支持批量导入用户'), dev, T);
  a = decideAssumption(addAssumption(a, '沿用现有鉴权'), 'A-1', 'accepted', dev, T);
  return setDimension(a, '性能', 'na', { reason: '单次最多 1000 行' });
}

function answered(id: string): Question {
  const q = createQuestion({ id, category: '技术约束', severity: 'blocking', question: '?', raisedAtStage: 'analysis' }, config, dev, T);
  return proposeAnswer(q, { text: '答案' }, dev, T);
}

describe('G1 理解门', () => {
  it('全部满足时通过', () => {
    expect(evaluateUnderstanding(readyAnalysis(), [answered('Q-1')], 'M', T).status).toBe('passed');
  });

  it('阻塞问题未确认时拦截', () => {
    const open = createQuestion({ id: 'Q-1', category: 'x', severity: 'blocking', question: '?', raisedAtStage: 'analysis' }, config, dev, T);
    const ev = evaluateUnderstanding(readyAnalysis(), [open], 'M', T);
    expect(ev.status).toBe('failed');
    expect(ev.checks.find((c) => c.id === 'blocking')?.detail).toContain('Q-1');
  });

  it('复述在确认后被修改，需要重新确认', () => {
    const a = setRestatement(readyAnalysis(), '支持批量导入和导出用户');
    expect(evaluateUnderstanding(a, [], 'M', T).checks.find((c) => c.id === 'restatement')?.passed).toBe(false);
  });

  it('没有任何内容时默认不通过（默认未验证）', () => {
    expect(evaluateUnderstanding({ nodes: [], assumptions: [], dimensions: [] }, [], 'S', T).status).toBe('failed');
  });

  it('新增问题后，之前的评估结果失效', () => {
    const a = readyAnalysis();
    const ev = evaluateUnderstanding(a, [], 'M', T);
    expect(isStillValid(ev, understandingBinding(a, []))).toBe(true);
    expect(isStillValid(ev, understandingBinding(a, [answered('Q-2')]))).toBe(false);
  });
});

describe('G2 规格门', () => {
  const specText = `## ADDED Requirements

### Requirement: 文件大小限制
系统 SHALL 拒绝超过 10MB 的文件（Q-1）。

#### Scenario: [AC-1] 上传超限文件
- **WHEN** 上传 12MB 文件
- **THEN** 提示错误

#### Scenario: 上传正常文件
`;
  const base = () => ({
    specs: [parseSpec('spec.md', specText)],
    sources: [{ path: 'spec.md', text: specText }],
    questions: [answered('Q-1'), answered('Q-2')],
    understandingBinding: 'up',
    approvals: [],
    tier: 'M' as const,
  });

  it('解析 Requirement / Scenario 与 AC 编号', () => {
    const s = parseSpec('spec.md', specText);
    expect(s.requirements[0]!.scenarios.map((x) => x.acId)).toEqual(['AC-1', undefined]);
  });

  it('缺 AC 编号、问题未被引用、未审批都会被拦截', () => {
    const ev = evaluateSpec(base(), T);
    const failed = ev.checks.filter((c) => !c.passed).map((c) => c.id);
    expect(failed).toEqual(['ac-ids', 'questions-traced', 'approved']);
    expect(ev.checks.find((c) => c.id === 'questions-traced')?.detail).toBe('Q-2 未被引用');
  });

  it('审批绑定内容：审批后 spec 改动会让审批失效', () => {
    const inputs = base();
    const binding = evaluateSpec(inputs, T).boundTo.value;
    const approved = { ...inputs, approvals: [{ target: 'spec' as const, hash: binding, actor: dev, at: T }] };
    expect(evaluateSpec(approved, T).checks.find((c) => c.id === 'approved')?.passed).toBe(true);
    const edited = { ...approved, sources: [{ path: 'spec.md', text: specText + '\n改了一行' }] };
    expect(evaluateSpec(edited, T).checks.find((c) => c.id === 'approved')?.passed).toBe(false);
  });
});

describe('G6 双子门禁', () => {
  const sha = 'a'.repeat(40);
  const evidence = (over: Partial<VerificationEvidence> = {}): VerificationEvidence => ({
    id: 'ev', sha, startedAt: T, finishedAt: T, mainTreeDirty: false, host: { node: 'v22', platform: 'darwin' },
    steps: [{ name: 'test', command: 'npm test', exitCode: 0, timedOut: false, durationMs: 1, outputTail: '', outputHash: '' }],
    ...over,
  });
  const verification = (over = {}) =>
    evaluateVerification(
      { headSha: sha, requiredSteps: ['test'], evidence: evidence(), acIds: ['AC-1'], requireAc: true, acCoverage: { 'AC-1': ['a.test.ts'] }, skipHits: [], protectedChanges: [], ...over },
      T,
    );
  const reviews = [
    { kind: 'agent' as const, sha, verdict: 'pass' as const, reviewer: { name: 'r', role: 'agent' as const }, at: T, coverage: ['AC-1'], findings: [] },
    { kind: 'human' as const, sha, verdict: 'pass' as const, reviewer: dev, at: T, coverage: [], findings: [] },
  ];

  it('两道门都通过、绑定同一 commit 时放行', () => {
    expect(evaluateTwin(verification(), evaluateReview(sha, reviews, T), sha, T).status).toBe('passed');
  });

  it('没有证据、证据属于旧 commit、步骤失败都会被拦截', () => {
    expect(verification({ evidence: undefined }).status).toBe('failed');
    expect(verification({ evidence: evidence({ sha: 'b'.repeat(40) }) }).status).toBe('failed');
    const failing = evidence({ steps: [{ ...evidence().steps[0]!, exitCode: 1 }] });
    expect(verification({ evidence: failing }).checks.find((c) => c.id === 'steps')?.detail).toBe('test 退出码 1');
  });

  it('AC 没有测试、新增 skip、改动受保护路径都会被拦截', () => {
    const ev = verification({ acCoverage: {}, skipHits: [{ file: 'a.test.ts', line: 'it.skip(' }], protectedChanges: ['vitest.config.ts'] });
    expect(ev.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(['ac-coverage', 'no-skips', 'protected']);
  });

  it('审查门：缺少开发者签字、存在阻塞问题都会被拦截', () => {
    expect(evaluateReview(sha, [reviews[0]!], T).status).toBe('failed');
    const blocked = [{ ...reviews[0]!, findings: [{ severity: 'blocking' as const, text: '漏做导出', anchor: 'AC-2' }] }, reviews[1]!];
    expect(evaluateReview(sha, blocked, T).status).toBe('failed');
  });

  it('有新提交后，旧 commit 上的审查不再算数', () => {
    const newSha = 'c'.repeat(40);
    expect(evaluateReview(newSha, reviews, T).status).toBe('failed');
    expect(evaluateTwin(verification(), evaluateReview(sha, reviews, T), newSha, T).status).toBe('failed');
  });
});

describe('状态机', () => {
  it('门禁未通过不能推进；S 档跳过 spec', () => {
    expect(() => nextStage('analysis', 'M', {})).toThrow(/G1/);
    const g1 = evaluateUnderstanding(readyAnalysis(), [], 'M', T);
    expect(nextStage('analysis', 'M', { G1: g1 })).toBe('spec');
    expect(nextStage('analysis', 'S', { G1: g1 })).toBe('implement');
  });

  it('离开后续阶段时，上游门禁也必须仍然通过', () => {
    const failedG1 = evaluateUnderstanding({ nodes: [], assumptions: [], dimensions: [] }, [], 'M', T);
    const passed = { gate: 'G2' as const, status: 'passed' as const, checks: [], boundTo: { kind: 'content' as const, value: 'x' }, evaluatedAt: T };
    expect(() => nextStage('spec', 'M', { G1: failedG1, G2: passed })).toThrow(/G1/);
  });
});
