import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyAnalysis } from '@specforge/core';
import { callPlatformTool, type AgentAdapter } from '@specforge/agents';
import { headSha } from '@specforge/runner';
import type { Actor, Question, Stage } from '@specforge/shared';
import { cmdAgentGenerate } from '../src/agent-cmds.ts';
import { addComment, defaultConfig, evaluateAll, resolveComment, Store } from '@specforge/store';

const dev: Actor = { name: 'yan', role: 'dev' };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const C = 'openspec/changes/c1';

const confirmed: Question = {
  id: 'Q-1',
  category: '业务规则',
  severity: 'blocking',
  question: '能否导入 admin？',
  options: [],
  requiredRoles: ['dev'],
  status: 'confirmed',
  dependsOn: [],
  raisedAtStage: 'analysis',
  raisedBy: dev,
  raisedAt: 'T',
  revisions: [{ rev: 1, text: '不能，一律 member', proposedBy: dev, proposedAt: 'T', state: 'confirmed', confirmations: [], hash: 'h' }],
};

function project(stage: Stage, files: Record<string, string> = {}): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sf-gen-'));
  dirs.push(dir);
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.email', 't@t');
  g(dir, 'config', 'user.name', 't');
  for (const [f, c] of Object.entries({ 'a.js': 'x\n', [`${C}/proposal.md`]: '# 批量导入\n管理员上传 CSV 导入用户\n', ...files })) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  mkdirSync(join(dir, '.specforge', 'changes'), { recursive: true });
  writeFileSync(join(dir, '.specforge', 'config.json'), JSON.stringify(defaultConfig()));
  const store = new Store(dir);
  store.create(
    {
      change: { id: 'c1', title: '批量导入', tier: 'M', stage, baseSha: headSha(dir), createdAt: 'T', createdBy: dev },
      analysis: emptyAnalysis(defaultConfig()),
      questions: [confirmed],
      reviews: [],
      approvals: [],
    },
    dev,
  );
  return store;
}

/** 假 agent：依次调用平台工具，记录每次的返回 */
function script(calls: [string, Record<string, unknown>][]): AgentAdapter & { outputs: { isError: boolean; text: string }[]; prompt: string } {
  const a = {
    backend: 'fake',
    outputs: [] as { isError: boolean; text: string }[],
    prompt: '',
    async run(spec: Parameters<AgentAdapter['run']>[0]) {
      a.prompt = spec.prompt;
      for (const [tool, args] of calls) a.outputs.push(callPlatformTool(spec.tools, tool, args));
      return { ok: spec.isComplete?.() ?? true, backend: 'fake', turns: calls.length, costUsd: 0, durationMs: 0, deniedTools: [] };
    },
  };
  return a;
}

const quiet = { override: {}, verbose: false, log: () => {} };
const SPEC = `## ADDED Requirements

### Requirement: CSV 导入
系统 SHALL 导入用户，角色一律为 member（Q-1）。

#### Scenario: [AC-1] 导入合法文件
- **WHEN** 导入 2 行
- **THEN** 返回 { success: 2 }

#### Scenario: [AC-2] 非管理员
- **WHEN** member 调用
- **THEN** 抛出"需要管理员权限"
`;
const DESIGN = '# 方案\n新增 importUsers 实现 AC-1；入口调用 requireAdmin 实现 AC-2。\n\n## 结构变更\n- [S-1] 新增模块 `src/import.js`\n';
const TASKS = '- [ ] T-1 实现导入（AC-1, S-1）\n- [ ] T-2 管理员校验（AC-2）依赖 T-1\n';

describe('生成类 agent（T2.8）', () => {
  it('spec-writer：提交先经引擎校验，不通过退回给 agent，通过后由引擎写入', async () => {
    const store = project('spec');
    const adapter = script([
      ['submit_spec', { specs: [{ capability: 'user-import', content: SPEC.replace('[AC-1] ', '') }], summary: '缺 AC' }],
      ['submit_spec', { specs: [{ capability: 'user-import', content: SPEC.replace('（Q-1）', '') }], summary: '缺问题引用' }],
      ['submit_spec', { specs: [{ capability: '../evil', content: SPEC }], summary: '越界' }],
      ['submit_spec', { specs: [{ capability: 'user-import', content: SPEC }], summary: '规格完成' }],
    ]);
    await cmdAgentGenerate(store, 'c1', dev, 'spec', { ...quiet, adapter });
    expect(adapter.outputs.map((o) => o.isError)).toEqual([true, true, true, false]);
    expect(adapter.outputs[0]!.text).toMatch(/每个 Scenario 都有 AC 编号/);
    expect(adapter.outputs[1]!.text).toMatch(/Q-1 未被引用/);
    expect(adapter.outputs[2]!.text).toMatch(/capability 只能是/);
    expect(adapter.prompt).toContain('Q-1：能否导入 admin？\n  答：不能，一律 member');

    expect(readFileSync(join(store.root, C, 'specs/user-import/spec.md'), 'utf8')).toBe(SPEC);
    expect(store.events().at(-1)).toMatchObject({ type: 'artifact.generated', payload: { kind: 'spec', files: [{ path: `${C}/specs/user-import/spec.md` }] } });
    // G2 只差人工审批
    const g2 = evaluateAll(store, store.load('c1')).G2!;
    expect(g2.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(['approved']);
  });

  it('已有产物时不覆盖，除非 --force；--force 时替换全部旧 spec', async () => {
    const store = project('spec', { [`${C}/specs/old/spec.md`]: '旧的' });
    const ok = () => script([['submit_spec', { specs: [{ capability: 'user-import', content: SPEC }], summary: '完成' }]]);
    await expect(cmdAgentGenerate(store, 'c1', dev, 'spec', { ...quiet, adapter: ok() })).rejects.toThrow(/已存在.*old\/spec\.md.*--force/);
    await cmdAgentGenerate(store, 'c1', dev, 'spec', { ...quiet, adapter: ok(), force: true });
    expect(existsSync(join(store.root, C, 'specs/old/spec.md'))).toBe(false);
    expect(store.events().at(-1)!.payload).toMatchObject({ replaced: [`${C}/specs/old/spec.md`] });
  });

  it('阶段不对、提出阻塞问题未提交：都不写入', async () => {
    const store = project('design');
    await expect(cmdAgentGenerate(store, 'c1', dev, 'spec', { ...quiet, adapter: script([]) })).rejects.toThrow(/spec 阶段/);
    const asker = script([['raise_question', { category: '业务规则', severity: 'blocking', question: '超过 1000 行怎么办？', why: '方案需要决定是否分批' }]]);
    await cmdAgentGenerate(store, 'c1', dev, 'design', { ...quiet, adapter: asker });
    expect(existsSync(join(store.root, C, 'design.md'))).toBe(false);
    expect(store.load('c1').questions.at(-1)).toMatchObject({ id: 'Q-2', raisedAtStage: 'design', raisedBy: { role: 'agent' } });
  });

  it('architect 与 planner：按 G3 / G4 规则校验', async () => {
    const store = project('design', { [`${C}/specs/user-import/spec.md`]: SPEC });
    const architect = script([
      ['submit_design', { content: '# 方案\n只实现 AC-1，还提到 AC-9。\n', summary: '不完整' }],
      ['submit_design', { content: DESIGN, summary: '方案完成' }],
    ]);
    await cmdAgentGenerate(store, 'c1', dev, 'design', { ...quiet, adapter: architect });
    expect(architect.outputs[0]!.text).toMatch(/AC-2 未在方案中说明[\s\S]*AC-9 不在 spec 中[\s\S]*缺少「## 结构变更」/);
    expect(readFileSync(join(store.root, C, 'design.md'), 'utf8')).toBe(DESIGN);

    const raw = store.load('c1');
    writeFileSync(store.path('changes', 'c1', 'change.json'), JSON.stringify({ ...raw.change, stage: 'tasks' }, null, 2) + '\n');
    store.acknowledgeOutOfBand('c1', dev, '测试：直接切到 tasks 阶段');
    const planner = script([
      ['submit_tasks', { content: '- [ ] T-1 实现（AC-1, S-9）依赖 T-1\n', summary: '有错' }],
      ['submit_tasks', { content: TASKS, summary: '任务完成' }],
    ]);
    await cmdAgentGenerate(store, 'c1', dev, 'tasks', { ...quiet, adapter: planner });
    expect(planner.outputs[0]!.text).toMatch(/S-9[\s\S]*AC-2 没有任务[\s\S]*S-1 没有任务[\s\S]*T-1 依赖自己/);
    expect(readFileSync(join(store.root, C, 'tasks.md'), 'utf8')).toBe(TASKS);
    expect(planner.prompt).toContain('[S-1] 新增模块');
    expect(evaluateAll(store, store.load('c1')).G4!.status).toBe('passed');
  });
});

describe('按评论修订（T3.5）', () => {
  it('有待处理评论时进入修订模式：不需要 --force，prompt 带行号与评论，必须逐条回应；评论挡住 G2 直到人确认', async () => {
    const store = project('spec', { [`${C}/specs/user-import/spec.md`]: SPEC });
    const path = `${C}/specs/user-import/spec.md`;
    const line = SPEC.split('\n').indexOf('- **THEN** 返回 { success: 2 }') + 1;
    const c = addComment(store, 'c1', dev, { path, line, text: '还要返回 failed: []' });
    expect(c).toMatchObject({ id: 'C-1', target: 'spec', quote: '- **THEN** 返回 { success: 2 }' });
    expect(evaluateAll(store, store.load('c1')).G2!.checks.find((x) => x.id === 'comments')).toMatchObject({ passed: false, detail: '未解决：C-1' });

    const revised = SPEC.replace('返回 { success: 2 }', '返回 { success: 2, failed: [] }');
    const adapter = script([
      ['submit_spec', { specs: [{ capability: 'user-import', content: revised }], summary: '没回应' }],
      ['submit_spec', { specs: [{ capability: 'user-import', content: revised }], summary: '已按评论修改', responses: [{ commentId: 'C-1', response: 'fixed', note: '补上 failed: []' }] }],
    ]);
    await cmdAgentGenerate(store, 'c1', dev, 'spec', { ...quiet, adapter });
    expect(adapter.outputs[0]!.text).toMatch(/缺少：C-1/);
    expect(adapter.outputs[1]!.isError).toBe(false);
    expect(adapter.prompt).toContain('本次是修订');
    expect(adapter.prompt).toContain(`C-1（yan）${path} 第 ${line} 行「- **THEN** 返回 { success: 2 }」：还要返回 failed: []`);
    expect(adapter.prompt).toContain(`${String(line).padStart(3)}| - **THEN** 返回 { success: 2 }`);

    expect(readFileSync(join(store.root, path), 'utf8')).toBe(revised);
    const state = store.load('c1');
    expect(state.comments![0]).toMatchObject({ status: 'addressed', history: [{ kind: 'addressed', response: 'fixed', note: '补上 failed: []', by: { role: 'agent' } }] });
    expect(store.events().slice(-2).map((e) => e.type)).toEqual(['artifact.generated', 'comment.addressed']);
    expect(store.events().at(-2)!.payload).toMatchObject({ revisedFor: ['C-1'] });
    // agent 回应后仍未解决
    expect(evaluateAll(store, state).G2!.checks.find((x) => x.id === 'comments')!.passed).toBe(false);
    resolveComment(store, 'c1', dev, 'C-1');
    expect(evaluateAll(store, store.load('c1')).G2!.checks.filter((x) => !x.passed).map((x) => x.id)).toEqual(['approved']);
    expect(store.outOfBand('c1')).toBeUndefined();
  });

  it('评论只能由人添加；没有评论的旧项目状态哈希不变', () => {
    const store = project('spec', { [`${C}/specs/user-import/spec.md`]: SPEC });
    expect(() => addComment(store, 'c1', { name: 'bot', role: 'agent' }, { path: `${C}/specs/user-import/spec.md`, line: 1, text: 'x' })).toThrow(/只能由人/);
    expect(existsSync(store.path('changes', 'c1', 'comments.json'))).toBe(false);
    expect(store.outOfBand('c1')).toBeUndefined();
  });
});

describe('范围外决定写进 proposal（T3.5 实测后）', () => {
  const declined: Question = { ...confirmed, id: 'Q-2', question: '是否发送欢迎邮件？', revisions: [{ ...confirmed.revisions[0]!, text: '不发送，不在本次范围' }] };

  it('spec-writer 只能向「范围外」追加引用已确认问题的条目；G2 的问题引用因此满足', async () => {
    const store = project('spec');
    store.mutate('c1', dev, 'question.raised', (s) => ({ ...s, questions: [...s.questions, declined, { ...declined, id: 'Q-3', status: 'open', revisions: [] }] }), () => ({}));
    const before = readFileSync(join(store.root, C, 'proposal.md'), 'utf8');
    const adapter = script([
      ['submit_spec', { specs: [{ capability: 'user-import', content: SPEC }], summary: '没引用问题', outOfScope: ['不发欢迎邮件'] }],
      ['submit_spec', { specs: [{ capability: 'user-import', content: SPEC }], summary: '引用未确认问题', outOfScope: ['不发欢迎邮件（Q-3）'] }],
      ['submit_spec', { specs: [{ capability: 'user-import', content: SPEC }], summary: '规格完成', outOfScope: ['批量导入不发送欢迎邮件（Q-2）'] }],
    ]);
    await cmdAgentGenerate(store, 'c1', dev, 'spec', { ...quiet, adapter });
    expect(adapter.outputs.map((o) => o.isError)).toEqual([true, true, false]);
    expect(adapter.outputs[0]!.text).toMatch(/必须引用已确认的问题编号/);
    expect(adapter.outputs[1]!.text).toMatch(/未确认或不存在的问题：Q-3/);

    const after = readFileSync(join(store.root, C, 'proposal.md'), 'utf8');
    expect(after).toBe(before.replace(/\n$/, '') + '\n\n## 范围外\n- 批量导入不发送欢迎邮件（Q-2）\n');
    expect(store.events().at(-1)!.payload).toMatchObject({ kind: 'spec', files: [{ path: `${C}/specs/user-import/spec.md` }, { path: `${C}/proposal.md` }] });
    const g2 = evaluateAll(store, store.load('c1')).G2!;
    expect(g2.checks.find((c) => c.id === 'questions-traced')!.passed).toBe(true);
  });
});
