import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createQuestion, emptyAnalysis, nextStage, resolveFixRound } from '@specforge/core';
import { callPlatformTool, type AgentAdapter, type AgentRunSpec } from '@specforge/agents';
import { headSha } from '@specforge/runner';
import type { Actor } from '@specforge/shared';
import { cmdAgentImplement, cmdAgentReview } from '../src/agent-cmds.ts';
import { checkTdd } from '../src/tdd.ts';
import { defaultConfig, evaluateAll, Store } from '@specforge/store';

const dev: Actor = { name: 'yan', role: 'dev' };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** 可运行的源码与测试：测试在没有实现时失败（RED），有实现后通过（GREEN） */
const src = (name: string) => ({ [`src/${name}.mjs`]: `export const ${name} = 1;\n` });
const testOf = (name: string, ac: string) => ({
  [`test/${name}.test.mjs`]: `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { ${name} } from '../src/${name}.mjs';\ntest('[${ac}] ${name}', () => assert.equal(${name}, 1));\n`,
});
const impl = (name: string, ac: string) => ({ ...src(name), ...testOf(name, ac) });

function project(config: Record<string, unknown> = {}): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sf-impl-'));
  dirs.push(dir);
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.email', 't@t');
  g(dir, 'config', 'user.name', 't');
  const files: Record<string, string> = {
    'a.js': 'export const a = 1;\n',
    'openspec/changes/c1/specs/x/spec.md': '### Requirement: R\n系统 SHALL 工作。\n\n#### Scenario: [AC-1] 正常\n#### Scenario: [AC-2] 另一个\n',
    'openspec/changes/c1/design.md': '实现 AC-1 AC-2\n\n## 结构变更\n- [S-1] 新增 `src/x.js`\n',
    'openspec/changes/c1/tasks.md': '- [ ] T-1 实现 x（AC-1, S-1）\n- [ ] T-2 补充（AC-2）依赖 T-1\n',
  };
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  mkdirSync(join(dir, '.specforge', 'changes'), { recursive: true });
  writeFileSync(join(dir, '.specforge', 'config.json'), JSON.stringify({ ...defaultConfig(), verify: [{ name: 'test', command: 'true' }], tdd: { command: 'node --test {files}' }, ...config }));
  const store = new Store(dir);
  store.create(
    {
      change: { id: 'c1', title: '示例', tier: 'M', stage: 'implement', baseSha: headSha(dir), createdAt: 'T', createdBy: dev },
      analysis: emptyAnalysis(defaultConfig()),
      questions: [],
      reviews: [],
      approvals: [],
    },
    dev,
  );
  return store;
}

/** 假 agent：在 cwd 中写入文件，然后调用 finish_task */
function writer(
  files: Record<string, string>,
  opts: { finish?: boolean; extra?: (spec: AgentRunSpec) => void; tests?: string[]; questions?: Record<string, unknown>[] } = {},
): AgentAdapter {
  return {
    backend: 'fake',
    async run(spec) {
      for (const [f, c] of Object.entries(files)) {
        const abs = f.startsWith('/') ? f : join(spec.cwd, f);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, c);
      }
      opts.extra?.(spec);
      for (const q of opts.questions ?? []) {
        const out = callPlatformTool(spec.tools, 'raise_question', q);
        if (out.isError) throw new Error(out.text);
      }
      if (opts.finish !== false) {
        const out = callPlatformTool(spec.tools, 'finish_task', { summary: '完成实现', testsAdded: opts.tests ?? ['[AC-1] 正常'] });
        if (out.isError) throw new Error(out.text);
      }
      return { ok: spec.isComplete?.() ?? true, backend: 'fake', turns: 1, costUsd: 0, durationMs: 0, deniedTools: [] };
    },
  };
}

const quiet = { override: {}, verbose: false, log: () => {} };
const types = (store: Store) => store.events().map((e) => e.type);

describe('sf agent implement', () => {
  it('在 worktree 中实现下一个任务：引擎勾选任务、提交、fast-forward 合入，并留痕', async () => {
    const store = project();
    const base = headSha(store.root);
    await cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer(impl('x', 'AC-1')) });

    const sha = headSha(store.root);
    expect(sha).not.toBe(base);
    expect(g(store.root, 'rev-parse', `${sha}~1`)).toBe(base);
    expect(readFileSync(join(store.root, 'src/x.mjs'), 'utf8')).toContain('x = 1');
    expect(readFileSync(join(store.root, 'openspec/changes/c1/tasks.md'), 'utf8')).toMatch(/^- \[x\] T-1/m);
    const msg = g(store.root, 'log', '-1', '--format=%B');
    expect(msg).toMatch(/^T-1: 实现 x/);
    expect(msg).toContain('SpecForge-Task: T-1');
    const committed = store.events().at(-1)!;
    expect(committed).toMatchObject({ type: 'implement.committed', payload: { taskId: 'T-1', sha, files: ['src/x.mjs', 'test/x.test.mjs'] } });
    const tdd = store.events().find((e) => e.type === 'tdd.recorded')!;
    expect(tdd.payload).toMatchObject({ taskId: 'T-1', base, sha, testFiles: ['test/x.test.mjs'], passed: true, green: { exitCode: 0 } });
    expect((tdd.payload.red as { exitCode: number }).exitCode).not.toBe(0);
    expect(committed.payload.tddEvidenceId).toBe(tdd.payload.evidenceId);
    expect(g(store.root, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('改动越界（改 spec）：整体丢弃，主分支不变，记录违规', async () => {
    const store = project();
    const base = headSha(store.root);
    const adapter = writer({ 'src/x.js': 'x', 'openspec/changes/c1/specs/x/spec.md': '偷偷改了规格' });
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter })).rejects.toThrow(/改动越界.*openspec\/changes\/c1\/specs\/x\/spec\.md/);
    expect(headSha(store.root)).toBe(base);
    expect(readFileSync(join(store.root, 'openspec/changes/c1/specs/x/spec.md'), 'utf8')).not.toContain('偷偷');
    expect(store.events().at(-1)).toMatchObject({ type: 'implement.rejected', payload: { taskId: 'T-1' } });
    expect(g(store.root, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('改动受保护路径同样被拒绝', async () => {
    const store = project();
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer({ 'vitest.config.ts': 'export default {}' }) })).rejects.toThrow(/vitest\.config\.ts/);
  });

  it('写到 worktree 之外的项目工作区：产出作废', async () => {
    const store = project();
    const adapter = writer({ 'src/x.js': 'x' }, { extra: () => writeFileSync(join(store.root, 'a.js'), 'export const a = 2;\n') });
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter })).rejects.toThrow(/worktree 之外/);
    expect(types(store)).not.toContain('implement.committed');
  });

  it('agent 自己 git commit 也会被收拢为引擎的单个提交', async () => {
    const store = project();
    const base = headSha(store.root);
    const adapter = writer(impl('x', 'AC-1'), {
      extra: (spec) => {
        g(spec.cwd, 'add', '-A');
        g(spec.cwd, 'commit', '-qm', 'agent 自己的提交');
      },
    });
    await cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter });
    expect(g(store.root, 'rev-list', '--count', `${base}..HEAD`)).toBe('1');
    expect(g(store.root, 'log', '-1', '--format=%s')).toBe('T-1: 实现 x（AC-1, S-1）');
  });

  it('没有调用 finish_task、没有改动、报告阻塞：都不提交', async () => {
    const store = project();
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer({ 'src/x.js': 'x' }, { finish: false }) })).rejects.toThrow(/没有完整提交/);
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer({}) })).rejects.toThrow(/没有产生任何改动/);
    const blocker: AgentAdapter = {
      backend: 'fake',
      async run(spec) {
        callPlatformTool(spec.tools, 'report_blocked', { reason: '规格没说超限怎么办' });
        return { ok: true, backend: 'fake', turns: 1, costUsd: 0, durationMs: 0, deniedTools: [] };
      },
    };
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: blocker })).rejects.toThrow(/报告阻塞/);
    expect(types(store)).toContain('implement.blocked');
    expect(types(store)).not.toContain('implement.committed');
  });

  it('前置条件：阶段、工作区干净、指定任务的依赖已完成', async () => {
    const store = project();
    writeFileSync(join(store.root, 'a.js'), 'dirty');
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer({}) })).rejects.toThrow(/未提交的改动/);
    g(store.root, 'checkout', '--', 'a.js');
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, taskId: 'T-2', adapter: writer({}) })).rejects.toThrow(/依赖尚未完成：T-1/);
  });

  it('按依赖顺序推进：T-1 完成后再做 T-2', async () => {
    const store = project();
    await cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer(impl('x', 'AC-1')) });
    expect(evaluateAll(store, store.load('c1')).G5).toMatchObject({ status: 'failed' });
    await cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer(impl('y', 'AC-2'), { tests: ['[AC-2] 另一个'] }) });
    expect(readFileSync(join(store.root, 'openspec/changes/c1/tasks.md'), 'utf8')).toBe('- [x] T-1 实现 x（AC-1, S-1）\n- [x] T-2 补充（AC-2）依赖 T-1\n');
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer({}) })).rejects.toThrow(/没有可做的任务/);
    expect(evaluateAll(store, store.load('c1')).G5).toMatchObject({ status: 'passed' });
  });
});

describe('G5 TDD 门', () => {
  it('新测试在实现前就通过：拒绝合入，记录未通过的证据', async () => {
    const store = project();
    const base = headSha(store.root);
    // 测试只验证已有的 a.js，实现前就能通过，证明不了新行为
    const passing = { 'test/x.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { a } from '../a.js';\ntest('[AC-1] x', () => assert.equal(a, 1));\n" };
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer({ ...src('x'), ...passing }) })).rejects.toThrow(/G5.*实现前就通过/);
    expect(headSha(store.root)).toBe(base);
    expect(store.events().find((e) => e.type === 'tdd.recorded')!.payload).toMatchObject({ passed: false, red: { exitCode: 0 } });
    expect(store.events().at(-1)).toMatchObject({ type: 'implement.rejected', payload: { taskId: 'T-1' } });
    expect(g(store.root, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('只改实现不改测试、或实现后测试仍失败：都被拒绝', async () => {
    const store = project();
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer(src('x')) })).rejects.toThrow(/没有新增或修改测试文件/);
    const wrong = { 'src/x.mjs': 'export const x = 2;\n', ...testOf('x', 'AC-1') };
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer(wrong) })).rejects.toThrow(/GREEN 退出码/);
    expect(types(store)).not.toContain('implement.committed');
  });

  it('未配置 tdd.command：运行 agent 之前就拒绝，G5 也不通过', async () => {
    const store = project({ tdd: undefined });
    let ran = false;
    const adapter: AgentAdapter = { backend: 'fake', async run() { ran = true; throw new Error('不应运行'); } };
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter })).rejects.toThrow(/tdd\.command/);
    expect(ran).toBe(false);
    expect(evaluateAll(store, store.load('c1')).G5!.checks.find((c) => c.id === 'configured')!.passed).toBe(false);
  });

  it('手工实现的任务用 sf tdd 补证据；commit 被改写出历史后证据失效', () => {
    const store = project();
    const base = headSha(store.root);
    const write = (files: Record<string, string>) => Object.entries(files).forEach(([f, c]) => {
      mkdirSync(dirname(join(store.root, f)), { recursive: true });
      writeFileSync(join(store.root, f), c);
    });
    write(impl('x', 'AC-1'));
    g(store.root, 'add', '-A');
    g(store.root, 'commit', '-qm', 'T-1 手工实现');
    const sha = headSha(store.root);
    expect(checkTdd(store, 'c1', dev, { taskId: 'T-1', base, sha }, () => {}).failures).toEqual([]);
    write(impl('y', 'AC-2'));
    write({ 'openspec/changes/c1/tasks.md': '- [x] T-1 实现 x（AC-1, S-1）\n- [x] T-2 补充（AC-2）依赖 T-1\n' });
    g(store.root, 'add', '-A');
    g(store.root, 'commit', '-qm', 'T-2 手工实现');
    expect(checkTdd(store, 'c1', dev, { taskId: 'T-2', base: sha, sha: headSha(store.root) }, () => {}).failures).toEqual([]);
    expect(evaluateAll(store, store.load('c1')).G5).toMatchObject({ status: 'passed' });

    // 改写历史：T-1 的 commit 不再在 HEAD 的历史中
    g(store.root, 'reset', '-q', '--soft', base);
    g(store.root, 'commit', '-qm', '压成一个提交');
    const g5 = evaluateAll(store, store.load('c1')).G5!;
    expect(g5.status).toBe('failed');
    expect(g5.checks.find((c) => c.id === 'red-green')!.detail).toMatch(/T-1 的 TDD 证据所在 commit 已不在当前历史中/);
  });
});

describe('问题回流（T2.9）', () => {
  const ask = (over: Record<string, unknown> = {}) => ({ category: '业务规则', severity: 'blocking', question: '超过 1000 行怎么办？', why: '规格没有说明上限', ...over });

  it('实现中提出阻塞问题：改动丢弃、问题入库、G1 失效、advance 被拦截、关联任务暂停', async () => {
    const store = project();
    const base = headSha(store.root);
    const adapter = writer(impl('x', 'AC-1'), { finish: false, questions: [ask()] });
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter })).rejects.toThrow(/提出阻塞问题 Q-1/);
    expect(headSha(store.root)).toBe(base);

    const state = store.load('c1');
    expect(state.questions).toHaveLength(1);
    expect(state.questions[0]).toMatchObject({ id: 'Q-1', severity: 'blocking', status: 'open', raisedAtStage: 'implement', taskIds: ['T-1'], raisedBy: { role: 'agent' } });
    expect(types(store)).toEqual(expect.arrayContaining(['question.raised', 'implement.blocked']));
    expect(store.outOfBand('c1')).toBeUndefined();

    const evals = evaluateAll(store, state);
    expect(evals.G1!.status).toBe('failed');
    expect(() => nextStage('implement', 'M', evals)).toThrow(/G1/);

    // T-1 暂停；T-2 依赖 T-1，也暂停
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer({}) })).rejects.toThrow(/暂停中：T-1（等待 Q-1）、T-2（等待 Q-1）/);
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, taskId: 'T-1', adapter: writer({}) })).rejects.toThrow(/T-1 已暂停.*Q-1/);
  });

  it('阻塞问题只关联 T-2 时，T-1 可以继续；之后剩余任务提示暂停', async () => {
    const store = project();
    store.mutate('c1', dev, 'question.raised', (s) => ({
      ...s,
      questions: [createQuestion({ id: 'Q-1', category: '业务规则', severity: 'blocking', question: 'T-2 的规则？', raisedAtStage: 'implement', taskIds: ['T-2'] }, store.config(), dev, 'T')],
    }), () => ({}));
    const lines: string[] = [];
    await cmdAgentImplement(store, 'c1', dev, { ...quiet, log: (l) => lines.push(l), adapter: writer(impl('x', 'AC-1')) });
    expect(types(store)).toContain('implement.committed');
    expect(lines.at(-1)).toBe('暂停中：T-2（等待 Q-1）');
  });

  it('非阻塞问题：照常提交，问题入库待回答', async () => {
    const store = project();
    await cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer(impl('x', 'AC-1'), { questions: [ask({ severity: 'important', taskIds: ['T-2'] })] }) });
    expect(types(store)).toContain('implement.committed');
    expect(store.load('c1').questions[0]).toMatchObject({ severity: 'important', taskIds: ['T-2'] });
  });

  it('raise_question 校验：分类、任务编号、依赖的问题必须存在；阻塞问题之后不能 finish_task', async () => {
    const store = project();
    const adapter = (q: Record<string, unknown>) => writer(impl('x', 'AC-1'), { finish: false, questions: [q] });
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: adapter(ask({ category: '随便' })) })).rejects.toThrow(/category 必须是/);
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: adapter(ask({ taskIds: ['T-9'] })) })).rejects.toThrow(/不存在的任务：T-9/);
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: adapter(ask({ dependsOn: ['Q-7'] })) })).rejects.toThrow(/不存在的问题：Q-7/);
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer(impl('x', 'AC-1'), { questions: [ask()] }) })).rejects.toThrow(/已提出阻塞问题/);
  });
});

describe('打回与修复轮次（T2.11）', () => {
  const failingReviewer: AgentAdapter = {
    backend: 'fake',
    async run(spec) {
      const out = callPlatformTool(spec.tools, 'submit_review', {
        verdict: 'fail',
        coverage: ['AC-1', 'AC-2'],
        findings: [{ severity: 'blocking', kind: 'missing', anchor: 'AC-1', text: 'x 应当是 2' }, { severity: 'non-blocking', text: '命名可以更清楚' }],
        summary: '漏做',
      });
      if (out.isError) throw new Error(out.text);
      return { ok: true, backend: 'fake', turns: 1, costUsd: 0, durationMs: 0, deniedTools: [] };
    },
  };
  const toStage = (store: Store, stage: 'closing') =>
    store.mutate('c1', dev, 'stage.advanced', (s) => ({ ...s, change: { ...resolveFixRound(s.change, headSha(store.root)), stage } }), () => ({ to: stage }));

  it('审查不通过 → 打回实现 → 实现 agent 只修复本轮问题 → 再次不通过且轮次用尽 → 升级给人', async () => {
    const store = project({ workflow: { maxFixRounds: 1 } });
    await cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer(impl('x', 'AC-1')) });
    await cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer(impl('y', 'AC-2'), { tests: ['[AC-2] 另一个'] }) });
    toStage(store, 'closing');
    const reviewed = headSha(store.root);

    // 第 1 次审查不通过：自动打回
    await cmdAgentReview(store, 'c1', dev, { ...quiet, adapter: failingReviewer });
    let change = store.load('c1').change;
    expect(change.stage).toBe('implement');
    expect(change.fixRounds).toHaveLength(1);
    expect(change.fixRounds![0]).toMatchObject({ round: 1, sha: reviewed, source: 'agent', findings: [{ anchor: 'AC-1', text: 'x 应当是 2' }] });
    expect(types(store).slice(-2)).toEqual(['review.recorded', 'stage.sent_back']);

    // 修复：prompt 带上本轮问题；不勾选任务、不做 G5；提交带修复轮次
    let prompt = '';
    const fixer = writer({ 'src/x.mjs': 'export const x = 2;\n', 'test/x.test.mjs': testOf('x', 'AC-1')['test/x.test.mjs']!.replace('equal(x, 1)', 'equal(x, 2)') }, {
      extra: (spec) => (prompt = spec.prompt),
    });
    const tasksBefore = readFileSync(join(store.root, 'openspec/changes/c1/tasks.md'), 'utf8');
    const tddCount = types(store).filter((t) => t === 'tdd.recorded').length;
    await cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: fixer });
    expect(prompt).toContain('第 1 轮修复');
    expect(prompt).toContain('[AC-1] (missing) x 应当是 2');
    expect(prompt).not.toContain('命名可以更清楚');
    expect(g(store.root, 'log', '-1', '--format=%B')).toMatch(/^FIX-1: 修复第 1 轮审查问题[\s\S]*SpecForge-Fix-Round: 1/);
    expect(readFileSync(join(store.root, 'openspec/changes/c1/tasks.md'), 'utf8')).toBe(tasksBefore);
    expect(types(store).filter((t) => t === 'tdd.recorded')).toHaveLength(tddCount);
    expect(store.events().at(-1)).toMatchObject({ type: 'implement.committed', payload: { taskId: 'FIX-1', fixRound: 1 } });

    // 回到收尾（结清本轮），第 2 次审查仍不通过：轮次用尽，升级给人
    toStage(store, 'closing');
    expect(store.load('c1').change.fixRounds![0]!.resolvedSha).toBe(headSha(store.root));
    await cmdAgentReview(store, 'c1', dev, { ...quiet, adapter: failingReviewer });
    change = store.load('c1').change;
    expect(change.stage).toBe('closing');
    expect(change.escalation).toMatchObject({ rounds: 1 });
    expect(types(store).at(-1)).toBe('change.escalated');
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer({}) })).rejects.toThrow(/已升级给人处理/);
    expect(store.outOfBand('c1')).toBeUndefined();
  });

  it('修复轮次中有未回答的阻塞问题：修复暂停', async () => {
    const store = project();
    await cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer(impl('x', 'AC-1')) });
    await cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer(impl('y', 'AC-2'), { tests: ['[AC-2] 另一个'] }) });
    toStage(store, 'closing');
    await cmdAgentReview(store, 'c1', dev, { ...quiet, adapter: failingReviewer });
    store.mutate('c1', dev, 'question.raised', (s) => ({
      ...s,
      questions: [createQuestion({ id: 'Q-1', category: '业务规则', severity: 'blocking', question: 'x 到底是几？', raisedAtStage: 'implement' }, store.config(), dev, 'T')],
    }), () => ({}));
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer({}) })).rejects.toThrow(/修复暂停.*Q-1/);
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, taskId: 'T-1', adapter: writer({}) })).rejects.toThrow(/修复进行中，不能指定任务/);
  });
});
