import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyAnalysis } from '@specforge/core';
import { callPlatformTool, type AgentAdapter, type AgentRunSpec } from '@specforge/agents';
import { headSha } from '@specforge/runner';
import type { Actor } from '@specforge/shared';
import { cmdAgentImplement } from '../src/agent-cmds.ts';
import { defaultConfig, Store } from '../src/store.ts';

const dev: Actor = { name: 'yan', role: 'dev' };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function project(): Store {
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
  writeFileSync(join(dir, '.specforge', 'config.json'), JSON.stringify({ ...defaultConfig(), verify: [{ name: 'test', command: 'true' }] }));
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
function writer(files: Record<string, string>, opts: { finish?: boolean; extra?: (spec: AgentRunSpec) => void; tests?: string[] } = {}): AgentAdapter {
  return {
    backend: 'fake',
    async run(spec) {
      for (const [f, c] of Object.entries(files)) {
        const abs = f.startsWith('/') ? f : join(spec.cwd, f);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, c);
      }
      opts.extra?.(spec);
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
    await cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer({ 'src/x.js': 'export const x = 1;\n', 'test/x.test.js': "test('[AC-1] 正常')\n" }) });

    const sha = headSha(store.root);
    expect(sha).not.toBe(base);
    expect(g(store.root, 'rev-parse', `${sha}~1`)).toBe(base);
    expect(readFileSync(join(store.root, 'src/x.js'), 'utf8')).toContain('x = 1');
    expect(readFileSync(join(store.root, 'openspec/changes/c1/tasks.md'), 'utf8')).toMatch(/^- \[x\] T-1/m);
    const msg = g(store.root, 'log', '-1', '--format=%B');
    expect(msg).toMatch(/^T-1: 实现 x/);
    expect(msg).toContain('SpecForge-Task: T-1');
    const committed = store.events().at(-1)!;
    expect(committed).toMatchObject({ type: 'implement.committed', payload: { taskId: 'T-1', sha, files: ['src/x.js', 'test/x.test.js'] } });
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
    const adapter = writer({ 'src/x.js': 'x' }, {
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
    await cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer({ 'src/x.js': 'x' }) });
    await cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer({ 'src/y.js': 'y' }, { tests: ['[AC-2] 另一个'] }) });
    expect(readFileSync(join(store.root, 'openspec/changes/c1/tasks.md'), 'utf8')).toBe('- [x] T-1 实现 x（AC-1, S-1）\n- [x] T-2 补充（AC-2）依赖 T-1\n');
    await expect(cmdAgentImplement(store, 'c1', dev, { ...quiet, adapter: writer({}) })).rejects.toThrow(/没有可做的任务/);
  });
});
