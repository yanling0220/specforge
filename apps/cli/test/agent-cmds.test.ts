import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyAnalysis } from '@specforge/core';
import { ScriptedAdapter, type AgentAdapter, type AgentRunSpec } from '@specforge/agents';
import { headSha } from '@specforge/runner';
import type { Actor } from '@specforge/shared';
import { cmdAgentAnalyze, cmdAgentReview } from '../src/agent-cmds.ts';
import { defaultConfig, Store } from '../src/store.ts';

const dev: Actor = { name: 'yan', role: 'dev' };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sf-cli-'));
  dirs.push(dir);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.js'), 'export const x = 1;\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  mkdirSync(join(dir, '.specforge', 'changes'), { recursive: true });
  const config = { ...defaultConfig(), dimensions: ['性能'] };
  writeFileSync(join(dir, '.specforge', 'config.json'), JSON.stringify(config));
  const store = new Store(dir);
  store.create(
    {
      change: { id: 'c1', title: '批量导入', tier: 'M', stage: 'analysis', baseSha: headSha(dir), createdAt: 'T', createdBy: dev },
      analysis: emptyAnalysis(config),
      questions: [],
      reviews: [],
      approvals: [],
    },
    dev,
  );
  return store;
}

const quiet = { override: {}, verbose: false, log: () => {} };

describe('sf agent analyze', () => {
  it('分析结果写入状态，并在哈希链中留下 agent.run 与提交记录', async () => {
    const store = project();
    const adapter = new ScriptedAdapter([
      { tool: 'set_restatement', args: { text: '管理员上传 CSV 批量创建用户' } },
      { tool: 'set_requirement_tree', args: { nodes: [{ id: 'G1', kind: 'goal', title: '批量导入' }] } },
      { tool: 'raise_question', args: { category: '业务规则', severity: 'blocking', question: '超限文件怎么处理？', why: '决定是否分片' } },
      { tool: 'set_dimension', args: { dimension: '性能', status: 'covered' } },
      { tool: 'finish_analysis', args: { summary: '完成' } },
    ]);
    await cmdAgentAnalyze(store, 'c1', dev, { ...quiet, adapter });
    const s = store.load('c1');
    expect(s.questions.map((q) => [q.id, q.raisedBy.role, q.requiredRoles])).toEqual([['Q-1', 'agent', ['dev', 'product']]]);
    expect(s.analysis.restatement?.text).toBe('管理员上传 CSV 批量创建用户');
    const types = store.events().map((e) => e.type);
    expect(types.slice(-2)).toEqual(['agent.run', 'analysis.agent_submitted']);
    expect(store.outOfBand('c1')).toBeUndefined();
  });

  it('只读 agent 改动了工作区：产出丢弃，记录失败事件', async () => {
    const store = project();
    const sneaky: AgentAdapter = {
      backend: 'sneaky',
      async run(spec: AgentRunSpec) {
        writeFileSync(join(spec.cwd, 'a.js'), 'export const x = 2;\n');
        return { ok: true, backend: 'sneaky', turns: 1, costUsd: 0, durationMs: 0, deniedTools: [] };
      },
    };
    await expect(cmdAgentAnalyze(store, 'c1', dev, { ...quiet, adapter: sneaky })).rejects.toThrow(/工作区发生了变化/);
    const last = store.events().at(-1)!;
    expect(last).toMatchObject({ type: 'agent.run', payload: { ok: false, workspaceChanged: true } });
    expect(store.load('c1').questions).toEqual([]);
  });
});

describe('sf agent review', () => {
  it('只能在 closing 阶段运行；结论绑定当前 HEAD', async () => {
    const store = project();
    const adapter = new ScriptedAdapter([{ tool: 'submit_review', args: { verdict: 'pass', coverage: [], summary: '没有问题' } }]);
    await expect(cmdAgentReview(store, 'c1', dev, { ...quiet, adapter })).rejects.toThrow(/closing/);

    const raw = store.load('c1');
    writeFileSync(store.path('changes', 'c1', 'change.json'), JSON.stringify({ ...raw.change, stage: 'closing' }));
    store.acknowledgeOutOfBand('c1', dev, '测试中直接切换阶段');
    await cmdAgentReview(store, 'c1', dev, { ...quiet, adapter });
    const review = store.load('c1').reviews[0]!;
    expect(review).toMatchObject({ kind: 'agent', verdict: 'pass', sha: headSha(store.root) });
    expect(review.reviewer.role).toBe('agent');
  });
});
