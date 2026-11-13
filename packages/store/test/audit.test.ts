import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chainEvent, emptyAnalysis, verifyChain, verifyLogAnchors } from '@specforge/core';
import { git, headSha, LOG_ANCHOR_REF, readLogAnchors, writeLogAnchor } from '@specforge/runner';
import type { ForgeEvent } from '@specforge/shared';
import { anchorLog, defaultConfig, Store, verifyLog } from '../src/index.ts';

const dev = { name: 'yan', role: 'dev' as const };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(): Store {
  const root = mkdtempSync(join(tmpdir(), 'sf-audit-'));
  dirs.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['commit', '--allow-empty', '-qm', 'init']);
  mkdirSync(join(root, '.specforge'), { recursive: true });
  writeFileSync(join(root, '.specforge', 'config.json'), JSON.stringify(defaultConfig()));
  const store = new Store(root);
  store.append({ type: 'test', actor: dev, payload: { value: 1 } });
  return store;
}

function rewrite(store: Store): void {
  const rewritten: ForgeEvent[] = [];
  for (const event of store.events()) {
    const { seq, hash, prevHash, at, ...input } = event;
    rewritten.push(chainEvent(rewritten.at(-1), { ...input, payload: { value: 999 } }, at));
  }
  writeFileSync(store.path('events.jsonl'), rewritten.map((event) => JSON.stringify(event)).join('\n') + '\n');
}

describe('Git 审计锚定（T4.4）', () => {
  it('使用独立线性提交；不改变 HEAD、暂存区、工作区、事件日志或 Git 身份', () => {
    const store = project();
    writeFileSync(join(store.root, 'staged.txt'), 'staged\n');
    git(store.root, ['add', 'staged.txt']);
    writeFileSync(join(store.root, 'staged.txt'), 'unstaged\n');
    const before = [headSha(store.root), git(store.root, ['diff', '--cached']), git(store.root, ['diff']), git(store.root, ['status', '--porcelain']), readFileSync(store.path('events.jsonl'), 'utf8')];
    const first = anchorLog(store);
    expect(first.created).toBe(true);
    expect(anchorLog(store)).toEqual({ anchor: first.anchor, created: false });
    expect([headSha(store.root), git(store.root, ['diff', '--cached']), git(store.root, ['diff']), git(store.root, ['status', '--porcelain']), readFileSync(store.path('events.jsonl'), 'utf8')]).toEqual(before);
    expect(git(store.root, ['config', 'user.email'])).toBe('test@example.invalid');
    expect(git(store.root, ['rev-list', '--parents', first.anchor.commit])).toBe(first.anchor.commit);
    store.append({ type: 'test', actor: dev, payload: { value: 2 } });
    const second = anchorLog(store);
    expect(git(store.root, ['rev-list', '--parents', '-1', second.anchor.commit])).toBe(`${second.anchor.commit} ${first.anchor.commit}`);
    expect(verifyLog(store)).toMatchObject({ ok: true, anchors: { count: 2, latest: { seq: 2 } } });
  });

  it('整链重新计算后内部校验通过，Git 锚定失败；拒绝用新锚定洗掉冲突', () => {
    const store = project();
    const { anchor } = anchorLog(store);
    rewrite(store);
    expect(verifyChain(store.events())).toEqual([]);
    expect(verifyLog(store)).toMatchObject({ ok: false, anchors: { problems: [{ seq: 1, problem: expect.stringMatching(/重写/) }] } });
    expect(() => anchorLog(store)).toThrow(/拒绝锚定/);
    expect(git(store.root, ['rev-parse', LOG_ANCHOR_REF])).toBe(anchor.commit);
    writeFileSync(store.path('events.jsonl'), '');
    expect(verifyLog(store).anchors.problems[0]!.problem).toMatch(/截断/);
    expect(() => anchorLog(store)).toThrow(/拒绝锚定/);
  });

  it('可信 commit 在本地审计分支被删后仍可校验，也能发现分支从头重建', () => {
    const store = project();
    const { anchor } = anchorLog(store);
    git(store.root, ['update-ref', '-d', LOG_ANCHOR_REF]);
    expect(verifyLog(store, anchor.commit)).toMatchObject({ ok: true, anchors: { count: 0 } });
    rewrite(store);
    anchorLog(store);
    expect(verifyLog(store).ok).toBe(true);
    expect(verifyLog(store, anchor.commit).ok).toBe(false);
    expect(verifyLog(store, 'HEAD').ok).toBe(false);
    expect(verifyLog(store, 'f'.repeat(40)).ok).toBe(false);
  });

  it('损坏的审计历史不能被忽略或覆盖；并发更新按原 tip 比较', () => {
    const store = project();
    const { anchor } = anchorLog(store);
    store.append({ type: 'test', actor: dev, payload: {} });
    expect(() => writeLogAnchor(store.root, { ...anchor, seq: 2 }, undefined)).toThrow(/并发锚定/);
    expect(git(store.root, ['rev-parse', LOG_ANCHOR_REF])).toBe(anchor.commit);
    git(store.root, ['update-ref', LOG_ANCHOR_REF, headSha(store.root)]);
    expect(verifyLog(store).ok).toBe(false);
    expect(() => anchorLog(store)).toThrow(/历史或锚定记录损坏/);
  });

  it('符号引用不能让锚定更新项目分支；未锚定与空日志明确区分', () => {
    const store = project();
    expect(verifyLog(store)).toMatchObject({ ok: true, anchors: { status: 'unverified', count: 0, latest: null } });
    writeFileSync(store.path('events.jsonl'), '');
    expect(() => anchorLog(store)).toThrow(/日志为空/);
    expect(readLogAnchors(store.root)).toEqual([]);
    store.append({ type: 'test', actor: dev, payload: {} });
    const before = headSha(store.root);
    git(store.root, ['symbolic-ref', LOG_ANCHOR_REF, 'refs/heads/missing-audit']);
    expect(() => anchorLog(store)).toThrow(/符号引用/);
    expect(headSha(store.root)).toBe(before);
  });

  it('锚定前检查带外状态修改', () => {
    const store = project();
    store.create({ change: { id: 'c1', title: 'x', tier: 'S', stage: 'analysis', baseSha: headSha(store.root), createdAt: 'T', createdBy: dev }, analysis: emptyAnalysis(store.config()), questions: [], reviews: [], approvals: [] }, dev);
    const file = store.path('changes', 'c1', 'change.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"analysis"', '"implement"'));
    expect(() => anchorLog(store)).toThrow(/拒绝锚定/);
    expect(readLogAnchors(store.root)).toEqual([]);
  });

  it('审计分支可单独推送保存；独立仓库中的旧锚定能发现本地整体重建', () => {
    const store = project();
    const { anchor } = anchorLog(store);
    const remote = mkdtempSync(join(tmpdir(), 'sf-audit-remote-'));
    dirs.push(remote);
    git(remote, ['init', '--bare', '-q']);
    git(store.root, ['push', remote, `${LOG_ANCHOR_REF}:${LOG_ANCHOR_REF}`]);
    expect(readLogAnchors(remote)).toEqual([anchor]);
    git(store.root, ['update-ref', '-d', LOG_ANCHOR_REF]);
    rewrite(store);
    anchorLog(store);
    expect(verifyLog(store).ok).toBe(true);
    expect(verifyLogAnchors(store.events(), readLogAnchors(remote))[0]!.problem).toMatch(/重写/);
  });

  it('CLI 创建与验证锚定，篡改时退出非零，产品角色不能手工锚定', () => {
    const store = project();
    const cli = join(import.meta.dirname, '../../../apps/cli/src/main.ts');
    const run = (...args: string[]) => execFileSync(process.execPath, [cli, 'log', ...args], { cwd: store.root, encoding: 'utf8', stdio: 'pipe' });
    expect(run('verify')).toMatch(/尚未锚定/);
    expect(() => run('anchor', '--as', 'lily:product')).toThrow();
    expect(run('anchor', '--as', 'yan:dev')).toMatch(/已锚定事件 #1/);
    const { commit } = readLogAnchors(store.root)[0]!;
    expect(run('verify', '--anchor', commit)).toMatch(/1 个 Git 锚定/);
    rewrite(store);
    expect(() => run('verify')).toThrow();
    expect(() => run('anchor', '--as', 'yan:dev')).toThrow();
  });
});
