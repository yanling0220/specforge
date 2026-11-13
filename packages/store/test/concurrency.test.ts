import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { addUser, emptyAnalysis, sha256, verifyChain } from '@specforge/core';
import { headSha, repositoryLockDir } from '@specforge/runner';
import { defaultConfig, Store, verifyLog } from '../src/index.ts';

const roots: string[] = [];
const children: ChildProcess[] = [];
const actor = { name: 'admin', role: 'dev' as const };
const worker = fileURLToPath(new URL('./fixtures/writer.ts', import.meta.url));
afterEach(async () => {
  await Promise.all(children.splice(0).filter((child) => child.exitCode === null && child.signalCode === null).map(async (child) => {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): Store {
  const root = mkdtempSync(join(tmpdir(), 'sf-concurrency-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.invalid');
  git('commit', '--allow-empty', '-qm', 'init');
  mkdirSync(join(root, '.specforge', 'changes'), { recursive: true });
  writeFileSync(join(root, '.specforge', 'config.json'), JSON.stringify(defaultConfig()));
  const store = new Store(root);
  store.mutateUsers(actor, 'user.added', (registry) => addUser(registry, { name: 'admin', roles: ['dev'], admin: true }, sha256('test'), undefined, 'T'), {});
  for (const id of ['a', 'b']) store.create({ change: { id, title: id, tier: 'S', stage: 'analysis', baseSha: headSha(root), createdAt: 'T', createdBy: actor }, analysis: emptyAnalysis(store.config()), questions: [], reviews: [], approvals: [] }, actor);
  return store;
}

async function writer(store: Store, mode: string, label = 'test', count = 1) {
  const child = fork(worker, [store.root, mode, label, String(count)], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  let errorOutput = '';
  child.stderr!.on('data', (chunk) => { errorOutput += chunk; });
  const exited = once(child, 'exit');
  const message = async (type: string) => {
    while (true) {
      const [payload] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`worker 提前退出：${errorOutput}`); })]);
      if (payload.type === type) return;
    }
  };
  await message('ready');
  return {
    child, message,
    start: () => child.send('go'),
    done: async () => { const [code, signal] = await exited; expect({ code, signal, errorOutput }).toEqual({ code: 0, signal: null, errorOutput: '' }); },
    exited,
  };
}

describe('仓库级跨进程保护（T4.3c）', () => {
  it('两个真实进程同时增加问题，读取在锁内完成，无丢失更新或重复编号', async () => {
    const store = project();
    const first = await writer(store, 'mutate', 'first', 12);
    const second = await writer(store, 'mutate', 'second', 12);
    first.start(); second.start();
    await Promise.all([first.done(), second.done()]);
    const questions = store.load('a').questions;
    expect(questions).toHaveLength(24);
    expect(new Set(questions.map((question) => question.id)).size).toBe(24);
    expect(store.events().filter((event) => event.type === 'question.raised')).toHaveLength(24);
    expect(verifyLog(store).ok).toBe(true);
  });

  it('不同 change、用户名册、证据、独立追加和创建共用连续事件序列', async () => {
    const store = project();
    const writers = await Promise.all([writer(store, 'mixed', 'a', 4), writer(store, 'mixed', 'b', 4), writer(store, 'create', 'created', 4)]);
    for (const child of writers) child.start();
    await Promise.all(writers.map((child) => child.done()));
    expect(store.users()!.users).toHaveLength(9);
    expect(store.listChanges()).toHaveLength(6);
    for (const id of ['a', 'b']) {
      expect(store.load(id).change.title).toBe(`${id}-3`);
      expect(store.evidenceIndex(id)).toHaveLength(4);
      expect(store.evidenceIndex(id).every((entry) => entry.hashOk)).toBe(true);
    }
    expect(store.events()).toHaveLength(39);
    expect(verifyChain(store.events())).toEqual([]);
    expect(verifyLog(store).ok).toBe(true);
  });

  it('锁忙立即拒绝且不调用写回调；真实路径别名共用锁，另一仓库不受阻塞', async () => {
    const store = project();
    const other = project();
    const alias = join(other.root, 'alias');
    symlinkSync(store.root, alias);
    const aliased = new Store(alias);
    const before = readFileSync(store.path('events.jsonl'), 'utf8');
    const holder = await writer(store, 'hold');
    const locked = holder.message('locked'); holder.start(); await locked;
    let called = false;
    expect(() => aliased.mutate('a', actor, 'blocked', (state) => { called = true; return state; }, () => ({}))).toThrow(/正在执行其他操作/);
    expect(() => store.append({ type: 'blocked', actor, payload: {} })).toThrow(/正在执行其他操作/);
    expect(() => store.recover('不能抢活锁')).toThrow(/正在执行其他操作/);
    expect(called).toBe(false);
    other.append({ type: 'unblocked', actor, payload: {} });
    expect(readFileSync(store.path('events.jsonl'), 'utf8')).toBe(before);
    holder.child.send('release'); await holder.done();
    expect(store.lockStatus().locked).toBe(false);
  });

  it('持锁进程强制退出后不自动抢锁，显式恢复先核对一致性且不伪造成功事件', async () => {
    const store = project();
    const before = store.events();
    const holder = await writer(store, 'hold');
    const locked = holder.message('locked'); holder.start(); await locked;
    holder.child.kill('SIGKILL'); await holder.exited;
    expect(store.lockStatus()).toMatchObject({ locked: true, alive: false, pending: false });
    expect(() => store.append({ type: 'blocked', actor, payload: {} })).toThrow(/中断锁/);
    store.recover('确认持锁进程已退出，未写文件');
    expect(store.events()).toEqual(before);
    store.append({ type: 'resumed', actor, payload: {} });
    expect(verifyLog(store).ok).toBe(true);
  });

  it('异步操作等待期间保持锁，嵌套可重入，返回后的异步回调不能继承过期租约', async () => {
    const store = project();
    const other = project();
    let release!: () => void;
    let delayed!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayedGate = new Promise<void>((resolve) => { delayed = resolve; });
    let delayedWrite!: Promise<unknown>;
    const operation = store.exclusive(async () => {
      other.exclusive(() => store.append({ type: 'nested', actor, payload: {} }));
      delayedWrite = delayedGate.then(() => store.append({ type: 'expired', actor, payload: {} })).catch((error) => error);
      await gate;
      store.append({ type: 'completed', actor, payload: {} });
    });
    expect(() => new Store(store.root).append({ type: 'blocked', actor, payload: {} })).toThrow(/正在执行其他操作/);
    release(); await operation;
    const holder = await writer(store, 'hold');
    const locked = holder.message('locked'); holder.start(); await locked;
    delayed();
    expect(await delayedWrite).toMatchObject({ code: 'write_busy' });
    holder.child.send('release'); await holder.done();
    expect(store.events().map((event) => event.type)).toEqual(['user.added', 'change.created', 'change.created', 'nested', 'completed']);
  });

  it('Git worktree 使用 common dir 中的同一把锁', async () => {
    const store = project();
    const worktree = join(store.root, 'linked');
    execFileSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: store.root, stdio: 'ignore' });
    expect(repositoryLockDir(worktree)).toBe(repositoryLockDir(store.root));
    const holder = await writer(store, 'hold');
    const locked = holder.message('locked'); holder.start(); await locked;
    expect(() => new Store(worktree).exclusive(() => undefined)).toThrow(/正在执行其他操作/);
    holder.child.send('release'); await holder.done();
  });

  it('普通 IO 异常即使释放锁，待恢复快照仍阻断下一次写入', async () => {
    const store = project();
    const file = join(store.changeDir('a'), 'questions.json');
    const before = readFileSync(file, 'utf8');
    const child = await writer(store, 'io-error', 'questions.json');
    child.start();
    expect((await child.exited)[0]).toBe(1);
    expect(store.lockStatus()).toMatchObject({ locked: false, pending: true });
    expect(() => store.append({ type: 'blocked', actor, payload: {} })).toThrow(/上次写入未完成/);
    expect(() => store.recover('部分状态不能自动补事件')).toThrow(/不一致/);
    writeFileSync(file, before);
    store.recover('按原快照还原未入链的问题');
    expect(store.events()).toHaveLength(3);
  });

  it.each(['specforge-write.pending.json', 'questions.json', 'events.jsonl'])('写入在 %s 替换后被杀死，部分结果阻断写入，完整结果可显式核对', async (target) => {
    const store = project();
    const beforeQuestions = readFileSync(join(store.changeDir('a'), 'questions.json'), 'utf8');
    const beforeEvents = readFileSync(store.path('events.jsonl'), 'utf8');
    const child = await writer(store, 'crash', target);
    child.start();
    expect((await child.exited)[1]).toBe('SIGKILL');
    expect(store.lockStatus()).toMatchObject({ locked: true, alive: false, pending: true });
    expect(() => store.acknowledgeOutOfBand('a', actor, '不能绕过恢复')).toThrow(/中断锁/);
    if (target === 'questions.json') {
      expect(() => store.recover('部分状态未入链')).toThrow(/不一致/);
      expect(existsSync(join(dirname(repositoryLockDir(store.root)), 'specforge-write.pending.json'))).toBe(true);
      writeFileSync(join(store.changeDir('a'), 'questions.json'), beforeQuestions);
      writeFileSync(store.path('events.jsonl'), beforeEvents);
    }
    store.recover('核对完整结果或恢复为原状态');
    expect(store.lockStatus()).toMatchObject({ locked: false, pending: false });
    expect(store.events().length).toBe(target === 'events.jsonl' ? 4 : 3);
    expect(verifyLog(store).ok).toBe(true);
  });

  it('校验或事件 payload 生成失败时文件、日志不变且不留下待恢复标记', () => {
    const store = project();
    const before = store.load('a');
    const events = store.events();
    expect(() => store.mutate('a', actor, 'failed', (state) => ({ ...state, change: { ...state.change, title: 'bad' } }), () => { throw new Error('payload failed'); })).toThrow('payload failed');
    expect(store.load('a')).toEqual(before);
    expect(store.events()).toEqual(events);
    expect(store.lockStatus()).toMatchObject({ locked: false, pending: false });
  });

  it.each([['crash-evidence', 'crashed.json', '.specforge/changes/a/evidence/crashed.json'], ['crash-artifact', 'design.md', 'openspec/changes/a/design.md']])('%s 中断时不能只凭状态哈希一致就解除保护', async (mode, target, file) => {
    const store = project();
    const before = store.events();
    const child = await writer(store, mode!, target!);
    child.start(); expect((await child.exited)[1]).toBe('SIGKILL');
    expect(() => store.recover('尚有未入链文件')).toThrow(/不匹配/);
    rmSync(join(store.root, file!));
    store.recover('人工删除未入链的新文件，恢复原快照');
    expect(store.events()).toEqual(before);
  });

  it('Git 已合入但提交事件未写时拒绝恢复，必须先人工还原 HEAD', async () => {
    const store = project();
    const base = headSha(store.root);
    const sha = execFileSync('git', ['commit-tree', 'HEAD^{tree}', '-p', base, '-m', 'implementation'], { cwd: store.root, encoding: 'utf8' }).trim();
    const child = await writer(store, 'crash-merge', sha);
    child.start(); expect((await child.exited)[1]).toBe('SIGKILL');
    expect(headSha(store.root)).toBe(sha);
    expect(() => store.recover('不能把未记录的合入补成成功')).toThrow(/不匹配/);
    execFileSync('git', ['update-ref', 'HEAD', base, sha], { cwd: store.root });
    const unrecorded = join(store.root, 'partial-merge.txt');
    writeFileSync(unrecorded, 'interrupted checkout');
    expect(() => store.recover('HEAD 还原但工作区仍不一致')).toThrow(/Git 合入中断/);
    rmSync(unrecorded);
    store.recover('临时仓库测试中恢复原 HEAD，工作树未变化');
    expect(store.events()).toHaveLength(3);
  });

  it('CLI 提供锁状态和显式恢复入口，活锁不被其他进程抢走', async () => {
    const store = project();
    const main = fileURLToPath(new URL('../../../apps/cli/src/main.ts', import.meta.url));
    const cli = (...args: string[]) => execFileSync(process.execPath, [main, ...args], { cwd: store.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const holder = await writer(store, 'hold');
    const locked = holder.message('locked'); holder.start(); await locked;
    expect(JSON.parse(cli('lock', 'status'))).toMatchObject({ locked: true, alive: true });
    expect(() => cli('lock', 'recover', '--reason', 'live')).toThrow();
    holder.child.kill('SIGKILL'); await holder.exited;
    expect(cli('lock', 'recover', '--reason', '核对干净中断')).toContain('没有重放');
    expect(JSON.parse(cli('lock', 'status'))).toMatchObject({ locked: false, pending: false });
    expect(store.events()).toHaveLength(3);
  });
});
