import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acIdsOf, emptyAnalysis } from '@specforge/core';
import type { AgentAdapter } from '@specforge/agents';
import { headSha } from '@specforge/runner';
import type { Actor, Stage } from '@specforge/shared';
import { cmdAgentReview } from '../src/agent-cmds.ts';
import { commitTree, evaluateAll, readSpecFacts, uncommittedSpecChanges, workTree } from '../src/engine.ts';
import { defaultConfig, Store } from '../src/store.ts';

const dev: Actor = { name: 'yan', role: 'dev' };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const SPEC = 'openspec/changes/c1/specs/x/spec.md';
const spec = (...acs: string[]) => `### Requirement: R\n系统 SHALL 工作。\n\n${acs.map((a) => `#### Scenario: [${a}] 场景\n`).join('')}`;

function write(root: string, files: Record<string, string>): void {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), c);
  }
}

/** 已提交：spec 有 AC-1、AC-2，测试只引用 AC-1 */
function project(stage: Stage): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sf-engine-'));
  dirs.push(dir);
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.email', 't@t');
  g(dir, 'config', 'user.name', 't');
  write(dir, { 'a.js': 'x\n' });
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  const base = headSha(dir);
  write(dir, { [SPEC]: spec('AC-1', 'AC-2'), 'test/x.test.js': "test('[AC-1] 场景')\n" });
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'spec');
  mkdirSync(join(dir, '.specforge', 'changes'), { recursive: true });
  writeFileSync(join(dir, '.specforge', 'config.json'), JSON.stringify({ ...defaultConfig(), verify: [{ name: 'test', command: 'true' }] }));
  const store = new Store(dir);
  store.create(
    {
      change: { id: 'c1', title: '示例', tier: 'M', stage, baseSha: base, createdAt: 'T', createdBy: dev },
      analysis: emptyAnalysis(defaultConfig()),
      questions: [],
      reviews: [],
      approvals: [],
    },
    dev,
  );
  return store;
}

const acCheck = (store: Store) => evaluateAll(store, store.load('c1')).G6A!.checks.find((c) => c.id === 'ac-coverage')!;

describe('OpenSpec 文件的读取来源（T2.10）', () => {
  it('同一份 spec 可以按工作区或按 commit 读取', () => {
    const store = project('spec');
    write(store.root, { [SPEC]: spec('AC-1') });
    const acs = (tree: Parameters<typeof readSpecFacts>[2]) => acIdsOf(readSpecFacts(store, 'c1', tree).specs);
    expect(acs(workTree(store.root))).toEqual(['AC-1']);
    expect(acs(commitTree(store.root, headSha(store.root)))).toEqual(['AC-1', 'AC-2']);
    expect(readSpecFacts(store, 'c1', commitTree(store.root, headSha(store.root))).sources.map((s) => s.path)).toEqual([SPEC]);
  });

  it('收尾阶段：AC 列表与 AC 覆盖都读 HEAD，未提交的 spec 改动不影响 G6', () => {
    const store = project('closing');
    expect(acCheck(store)).toMatchObject({ passed: false, detail: 'AC-2 没有测试引用' });

    // 工作区删掉 AC-2：以前 AC 列表读工作区会误判通过；现在仍按 HEAD 要求 AC-2
    write(store.root, { [SPEC]: spec('AC-1') });
    expect(acCheck(store)).toMatchObject({ passed: false, detail: 'AC-2 没有测试引用' });
    expect(uncommittedSpecChanges(store, 'c1')).toEqual([SPEC]);

    // 工作区新增 AC-3 也不参与；提交后才生效
    write(store.root, { [SPEC]: spec('AC-1') + '#### Scenario: [AC-3] 新\n' });
    expect(acCheck(store).detail).toBe('AC-2 没有测试引用');
    g(store.root, 'add', '-A');
    g(store.root, 'commit', '-qm', '改 spec');
    expect(acCheck(store).detail).toBe('AC-3 没有测试引用');
    expect(uncommittedSpecChanges(store, 'c1')).toEqual([]);
  });

  it('实现阶段之前仍按工作区评估（人在提交前编辑 spec）', () => {
    const store = project('spec');
    write(store.root, { [SPEC]: spec('AC-1', 'AC-1') });
    const g2 = evaluateAll(store, store.load('c1')).G2!;
    expect(g2.checks.find((c) => c.id === 'ac-unique')).toMatchObject({ passed: false, detail: 'AC-1 重复' });
  });

  it('审查 agent 看到的是被审查 commit 中的 spec，而不是工作区', async () => {
    const store = project('closing');
    write(store.root, { [SPEC]: spec('AC-1') + '#### Scenario: [AC-9] 未提交的场景\n' });
    let prompt = '';
    const adapter: AgentAdapter = {
      backend: 'fake',
      async run(spec) {
        prompt = spec.prompt;
        return { ok: false, error: '只看 prompt', backend: 'fake', turns: 0, costUsd: 0, durationMs: 0, deniedTools: [] };
      },
    };
    await expect(cmdAgentReview(store, 'c1', dev, { override: {}, verbose: false, log: () => {}, adapter })).rejects.toThrow(/只看 prompt/);
    expect(prompt).toContain('[AC-2]');
    expect(prompt).not.toContain('AC-9');
  });
});
