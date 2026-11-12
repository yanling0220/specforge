import { describe, expect, it } from 'vitest';
import type { Actor, ProjectConfig } from '@specforge/shared';
import {
  analystTools,
  applyAnalysisDraft,
  emptyAnalysisDraft,
  emptyReviewDraft,
  makeCanUseTool,
  resolveProfile,
  reviewerTools,
  reviewRecordFromDraft,
  ScriptedAdapter,
  type AnalystContext,
  type ReviewerContext,
} from '../src/index.ts';

const T = '2026-11-12T10:00:00Z';
const agent: Actor = { name: 'analyst@scripted', role: 'agent' };
const config = {
  dimensions: ['性能', '安全与权限'],
  confirmPolicy: { 业务规则: ['dev', 'product'], default: ['dev'] },
} as unknown as ProjectConfig;

const analystCtx = (): AnalystContext => ({
  changeId: 'x',
  title: '批量导入',
  proposal: '支持 CSV 批量导入用户',
  dimensions: config.dimensions,
  existing: { questions: [], assumptions: [] },
});

const fullAnalysis = [
  { tool: 'set_restatement', args: { text: '管理员上传 CSV 批量创建用户，减少逐个录入' } },
  {
    tool: 'set_requirement_tree',
    args: {
      nodes: [
        { id: 'G1', kind: 'goal', title: '批量导入' },
        { id: 'F1', parentId: 'G1', kind: 'feature', title: '上传文件' },
        { id: 'F1.S1', parentId: 'F1', kind: 'scenario', title: '文件超限' },
      ],
    },
  },
  { tool: 'add_assumption', args: { text: '沿用现有管理员鉴权' } },
  {
    tool: 'raise_question',
    args: {
      category: '业务规则', severity: 'blocking', question: '超限文件怎么处理？', why: '决定是否分片', nodeId: 'F1.S1',
      options: [{ id: 'A', text: '拒绝', recommended: true }, { id: 'B', text: '分片' }],
    },
  },
  { tool: 'raise_question', args: { category: '性能', severity: 'minor', question: '单次最多多少行？', why: '决定是否异步', dependsOn: ['D-1'] } },
  { tool: 'set_dimension', args: { dimension: '性能', status: 'question', reason: '行数上限见 D-2', questionIds: ['D-2'] } },
  { tool: 'set_dimension', args: { dimension: '安全与权限', status: 'covered' } },
  { tool: 'finish_analysis', args: { summary: '主要风险是文件大小' } },
];

describe('需求分析 agent 的平台工具', () => {
  it('完整流程：草稿合并进状态，D-n 映射为 Q-n，业务问题需要双方确认', async () => {
    const draft = emptyAnalysisDraft();
    const adapter = new ScriptedAdapter(fullAnalysis);
    await adapter.run({ role: 'analyst', systemPrompt: '', prompt: '', cwd: '.', readOnly: true, profile: { backend: 'claude' }, tools: analystTools(draft, analystCtx()), toolNamespace: 'specforge' });
    expect(adapter.calls.filter((c) => c.isError)).toEqual([]);

    const analysis = { nodes: [], assumptions: [], dimensions: config.dimensions.map((dimension) => ({ dimension, status: 'pending' as const })) };
    const applied = applyAnalysisDraft(analysis, [], draft, config, agent, 'analysis', T);
    expect(applied.idMap).toEqual({ 'D-1': 'Q-1', 'D-2': 'Q-2' });
    expect(applied.questions[0]).toMatchObject({ id: 'Q-1', requiredRoles: ['dev', 'product'], raisedBy: agent, status: 'open' });
    expect(applied.questions[1]!.dependsOn).toEqual(['Q-1']);
    expect(applied.analysis.dimensions.find((d) => d.dimension === '性能')).toMatchObject({ status: 'question', reason: '行数上限见 Q-2', questionIds: ['Q-2'] });
    expect(applied.analysis.restatement?.confirmation).toBeUndefined();
  });

  it('问题分类必须来自确认策略，防止业务问题绕过产品确认', () => {
    const draft = emptyAnalysisDraft();
    const tools = analystTools(draft, { ...analystCtx(), categories: [{ name: '业务规则', roles: ['dev', 'product'] }, { name: '性能', roles: ['dev'] }] });
    const raise = tools.find((t) => t.name === 'raise_question')!;
    expect(() => raise.handler({ category: '输入与校验', severity: 'minor', question: '列定义？', why: '影响解析', options: [], dependsOn: [] })).toThrow(/category 必须是/);
    expect(raise.handler({ category: '业务规则', severity: 'minor', question: '列定义？', why: '影响解析', options: [], dependsOn: [] })).toBe('已记录问题 D-1');
  });

  it('校验失败的调用返回错误给模型，不写入草稿', async () => {
    const draft = emptyAnalysisDraft();
    const adapter = new ScriptedAdapter([
      { tool: 'raise_question', args: { category: 'x', severity: 'blocking', question: '超限怎么办？', why: '影响设计', options: [{ id: 'A', text: 'a' }], defaultOptionId: 'A' } },
      { tool: 'set_dimension', args: { dimension: '性能', status: 'na' } },
      { tool: 'set_dimension', args: { dimension: '不存在', status: 'covered' } },
      { tool: 'finish_analysis', args: { summary: '提前结束' } },
    ]);
    await adapter.run({ role: 'analyst', systemPrompt: '', prompt: '', cwd: '.', readOnly: true, profile: { backend: 'claude' }, tools: analystTools(draft, analystCtx()), toolNamespace: 'specforge' });
    expect(adapter.calls.map((c) => c.isError)).toEqual([true, true, true, true]);
    expect(adapter.calls[3]!.result).toMatch(/还缺.*需求复述.*需求分解树.*维度结论/);
    expect(draft.questions).toEqual([]);
    expect(() => applyAnalysisDraft({ nodes: [], assumptions: [], dimensions: [] }, [], draft, config, agent, 'analysis', T)).toThrow(/finish_analysis/);
  });

  it('增量分析不覆盖已确认的复述和人已下结论的维度', async () => {
    const draft = emptyAnalysisDraft();
    await new ScriptedAdapter(fullAnalysis).run({ role: 'analyst', systemPrompt: '', prompt: '', cwd: '.', readOnly: true, profile: { backend: 'claude' }, tools: analystTools(draft, analystCtx()), toolNamespace: 'specforge' });
    const human: Actor = { name: 'yan', role: 'dev' };
    const analysis = {
      restatement: { text: '旧复述', hash: 'h', confirmation: { role: 'dev' as const, actor: human, at: T, hash: 'h' } },
      nodes: [],
      assumptions: [],
      dimensions: [{ dimension: '性能', status: 'na' as const, reason: '人工判断' }, { dimension: '安全与权限', status: 'pending' as const }],
    };
    const applied = applyAnalysisDraft(analysis, [], draft, config, agent, 'analysis', T);
    expect(applied.analysis.restatement?.text).toBe('旧复述');
    expect(applied.skippedDimensions).toEqual(['性能']);
    expect(applied.analysis.dimensions.find((d) => d.dimension === '安全与权限')?.status).toBe('covered');
  });
});

describe('审查 agent 的平台工具', () => {
  const ctx = { acIds: ['AC-1', 'AC-2'], decisions: [{ id: 'Q-1', question: '?', answer: '拒绝' }] } as unknown as ReviewerContext;

  it('覆盖不全、阻塞问题缺锚点、结论与问题矛盾都会被拒绝', () => {
    const draft = emptyReviewDraft();
    const [submit] = reviewerTools(draft, ctx);
    expect(() => submit!.handler({ verdict: 'pass', coverage: ['AC-1'], findings: [], summary: '没问题' })).toThrow(/AC-2/);
    expect(() =>
      submit!.handler({ verdict: 'fail', coverage: ['AC-1', 'AC-2'], findings: [{ severity: 'blocking', kind: 'missing', anchor: 'AC-9', text: '漏了导出' }], summary: '有问题' }),
    ).toThrow(/锚点/);
    expect(() =>
      submit!.handler({ verdict: 'pass', coverage: ['AC-1', 'AC-2'], findings: [{ severity: 'blocking', kind: 'missing', anchor: 'AC-2', text: '编码检查缺失' }], summary: '有问题' }),
    ).toThrow(/不能是 pass/);
    expect(draft.submitted).toBe(false);
  });

  it('合法结论生成 agent 审查记录', () => {
    const draft = emptyReviewDraft();
    reviewerTools(draft, ctx)[0]!.handler({
      verdict: 'fail',
      coverage: ['AC-1', 'AC-2'],
      findings: [{ severity: 'blocking', kind: 'unplanned', anchor: 'Q-1', text: '实现了分片上传，但已确认答案是直接拒绝' }],
      summary: '存在计划外新增',
    });
    const record = reviewRecordFromDraft(draft, 'sha', agent, T);
    expect(record).toMatchObject({ kind: 'agent', verdict: 'fail', coverage: ['AC-1', 'AC-2'] });
    expect(() => reviewRecordFromDraft(emptyReviewDraft(), 'sha', agent, T)).toThrow(/submit_review/);
  });
});

describe('Claude 适配层的工具拦截', () => {
  it('只读角色只放行读工具和本角色的平台工具', async () => {
    const denied: string[] = [];
    const can = makeCanUseTool(
      { readOnly: true, cwd: '.', toolNamespace: 'specforge', tools: [{ name: 'submit_review', description: '', shape: {}, handler: () => '' }] },
      (name) => denied.push(name),
    );
    const sig = { signal: new AbortController().signal, toolUseID: 't' } as never;
    for (const t of ['Read', 'Grep', 'mcp__specforge__submit_review']) expect((await can(t, {}, sig))?.behavior).toBe('allow');
    for (const t of ['Write', 'Edit', 'Bash', 'mcp__other__x', 'mcp__specforge__finish_analysis']) expect((await can(t, {}, sig))?.behavior).toBe('deny');
    expect(denied).toEqual(['Write', 'Edit', 'Bash', 'mcp__other__x', 'mcp__specforge__finish_analysis']);
  });

  it('角色配置按 默认 ← 项目 ← 角色 ← 命令行 合并', () => {
    const p = resolveProfile('reviewer', { default: { backend: 'claude', model: 'claude-opus-5-5' }, roles: { reviewer: { backend: 'codex', effort: 'xhigh' } } }, { effort: 'max', model: undefined });
    expect(p).toMatchObject({ backend: 'codex', model: 'claude-opus-5-5', effort: 'max', maxTurns: 40 });
  });
});
