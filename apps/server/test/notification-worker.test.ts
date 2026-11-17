import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationLedger, questionAction, verifyLog, Store } from '@specforge/store';
import { NotificationWorker } from '../src/notification-worker.ts';
import { feishuCredentials } from '../src/notification-config.ts';
import type { FeishuResponse, FeishuTransport } from '../src/feishu.ts';
import { registerProjects } from '../src/projects.ts';
import { notificationProject, notificationSettings, webhook } from './fixtures/notification-project.ts';

const roots: string[] = [];
const workers: NotificationWorker[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});
const accepted = (): FeishuResponse => ({ status: 200, code: 0, retryAfter: null });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
function project() { const store = notificationProject(); roots.push(store.root); return store; }
function credentials(id = 'a') {
  const settings = notificationSettings(id);
  vi.stubEnv(settings.webhookEnv, webhook(id)); vi.stubEnv(settings.signingSecretEnv, `private-${id}-secret`);
  return settings;
}
function setup(store: Store, transport: FeishuTransport, id = 'a', now = Date.now) {
  const settings = credentials(id);
  const registered = registerProjects([{ id, root: store.root }])[0]!;
  const worker = new NotificationWorker({ store, projectId: id, settings, multiProject: true, check: registered.check, transport, now, random: () => 0 });
  workers.push(worker);
  return { worker, ledger: new NotificationLedger(store, { projectId: id, enabled: true, route: feishuCredentials(settings).route }) };
}
async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw new Error('等待通知检查点超时'); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

describe('逐项目通知 worker', () => {
  it('无配置 / 显式关闭不读凭据、不写通知或外连', async () => {
    const store = project(); const before = store.events();
    const transport = vi.fn(async () => accepted());
    for (const settings of [undefined, { projectId: 'a', enabled: false, webhookEnv: 'MISSING' }]) {
      const worker = new NotificationWorker({ store, projectId: 'a', settings, multiProject: false, check() { throw new Error('不应访问'); }, transport }); workers.push(worker);
      await worker.tick();
      expect(worker.status()).toEqual({ state: 'disabled' });
    }
    expect(transport).not.toHaveBeenCalled(); expect(store.events()).toEqual(before);
  });

  it('受理只发送一次；通知事件不循环，关闭 / 重启沿用账本且业务字节不变', async () => {
    const store = project(); const transport = vi.fn(async () => accepted());
    const before = readFileSync(store.path('changes', 'same', 'questions.json'), 'utf8');
    const { worker, ledger } = setup(store, transport);
    await worker.tick(); await worker.tick(); await worker.tick();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(ledger.list()).toMatchObject([{ status: 'accepted', attempts: 1 }]);
    await worker.close();
    const restart = setup(new Store(store.root), transport).worker;
    await restart.tick();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(readFileSync(store.path('changes', 'same', 'questions.json'), 'utf8')).toBe(before);
    expect(JSON.stringify(store.events().filter((event) => event.type.startsWith('notification.')))).not.toMatch(/private-|ou_a_pm|open\.feishu/);
    expect(verifyLog(store).ok).toBe(true);
  });

  it('配置与凭据错误为 blocked；修复后原快照仍待管理员重试，无自动补发', async () => {
    const store = project(); const transport = vi.fn(async () => accepted()); const settings = credentials();
    vi.stubEnv(settings.signingSecretEnv, '');
    const worker = new NotificationWorker({ store, projectId: 'a', settings, multiProject: false, check() {}, transport }); workers.push(worker);
    await worker.tick();
    expect(worker.status()).toEqual({ state: 'blocked', reason: 'configuration' });
    const ledger = new NotificationLedger(store, { projectId: 'a' });
    expect(ledger.list()).toMatchObject([{ status: 'blocked', reason: 'configuration', attempts: 0 }]);
    vi.stubEnv(settings.signingSecretEnv, 'fixed'); await worker.tick();
    expect(transport).not.toHaveBeenCalled();
    expect(ledger.list()[0]!.status).toBe('blocked');
  });

  it('明确限流遵守到期时间，最多五次，重启不能清零预算', async () => {
    const store = project(); let now = Date.now();
    const transport = vi.fn(async () => ({ status: 200, code: 11232, retryAfter: null }));
    let { worker, ledger } = setup(store, transport, 'a', () => now);
    for (let attempt = 1; attempt <= 5; attempt++) {
      await worker.tick(); expect(transport).toHaveBeenCalledTimes(attempt);
      const record = ledger.list()[0]!;
      expect(record.attempts).toBe(attempt);
      if (attempt < 5) {
        expect(record.status).toBe('retry_wait');
        await worker.close(); worker = setup(store, transport, 'a', () => now).worker;
        await worker.tick(); expect(transport).toHaveBeenCalledTimes(attempt);
        now = Date.parse(record.nextAttemptAt!);
      } else expect(record).toMatchObject({ status: 'failed', reason: 'retry_exhausted' });
    }
    now += 3600_000; await worker.tick(); expect(transport).toHaveBeenCalledTimes(5);
    expect(verifyLog(store).ok).toBe(true);
  });

  it('至少间隔两秒；发送前取消过期版本，新的问题版本使用新键', async () => {
    const store = project(); let now = Date.now(); const transport = vi.fn(async () => accepted());
    const { worker, ledger } = setup(store, transport, 'a', () => now);
    await worker.tick();
    questionAction(store, 'same', { name: 'dev', role: 'dev' }, 'Q-1', { kind: 'answer', text: 'new answer' });
    await worker.tick(); expect(transport).toHaveBeenCalledTimes(1);
    const queued = ledger.list().find((record) => record.status === 'queued')!;
    questionAction(store, 'same', { name: 'pm', role: 'product' }, 'Q-1', { kind: 'confirm' });
    now += 2000; await worker.tick(); expect(transport).toHaveBeenCalledTimes(1);
    expect(ledger.list().find((record) => record.key === queued.key)!.status).toBe('cancelled');
    questionAction(store, 'same', { name: 'dev', role: 'dev' }, 'Q-1', { kind: 'answer', text: 'third', reason: '新的业务要求' });
    await worker.tick(); expect(transport).toHaveBeenCalledTimes(2);
  });

  it('慢传输不持仓库锁、不阻止业务或健康 B；重复 tick 合并，活 owner 不被恢复为 unknown', async () => {
    const a = project(); const b = project(); const response = deferred<FeishuResponse>();
    const transport = vi.fn(() => response.promise);
    const first = setup(a, transport);
    const running = first.worker.tick();
    await waitFor(() => transport.mock.calls.length === 1);
    expect(first.worker.tick()).toBe(running);
    expect(a.lockStatus().locked).toBe(false);
    questionAction(a, 'same', { name: 'dev', role: 'dev' }, 'Q-1', { kind: 'answer', text: 'business-once' });
    const competing = setup(a, vi.fn(async () => accepted()));
    await competing.worker.tick();
    expect(competing.worker.status()).toEqual({ state: 'paused', reason: 'owner' });
    expect(first.ledger.list()[0]!.status).toBe('started');
    const secondTransport = vi.fn<FeishuTransport>(async () => accepted());
    const second = setup(b, secondTransport, 'b'); await second.worker.tick();
    expect(secondTransport).toHaveBeenCalledTimes(1);
    const body = JSON.parse(secondTransport.mock.calls[0]![1]!);
    expect(JSON.stringify(body)).toContain('/p/b/#/changes/same/analysis/Q-1');
    response.resolve(accepted()); await running;
    expect(transport).toHaveBeenCalledTimes(1);
    expect(first.ledger.list().filter((record) => record.status === 'accepted')).toHaveLength(1);
    expect(a.events().filter((event) => event.type === 'question.answered')).toHaveLength(2);
  });

  it('受理后记账遇到写锁只重试落盘，绝不重发网络；关闭等待在途结果', async () => {
    const store = project(); const response = deferred<FeishuResponse>(); const transport = vi.fn(() => response.promise);
    const { worker, ledger } = setup(store, transport);
    const running = worker.tick(); await waitFor(() => transport.mock.calls.length === 1);
    const release = deferred<void>();
    const held = store.exclusive(() => release.promise);
    response.resolve(accepted());
    const closing = worker.close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    release.resolve(); await held; await closing; await running;
    expect(ledger.list()).toMatchObject([{ status: 'accepted', attempts: 1 }]);
    await worker.tick(); expect(transport).toHaveBeenCalledTimes(1);
    expect(worker.status()).toEqual({ state: 'stopped' });
  });

  it('网络断线或语义不明结果为 unknown，后续扫描和重启都不自动发送', async () => {
    const store = project(); const transport = vi.fn(async () => { throw new Error('private-error'); });
    const { worker, ledger } = setup(store, transport); await worker.tick();
    expect(ledger.list()).toMatchObject([{ status: 'unknown', attempts: 1 }]);
    await worker.close(); await setup(store, transport).worker.tick();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('换群指纹暂停旧快照；损坏、pending 和状态树符号链接均不被通知覆盖', async () => {
    const store = project(); const transport = vi.fn(async () => accepted()); const settings = credentials();
    const ledger = new NotificationLedger(store, { projectId: 'a', enabled: true, route: feishuCredentials(settings).route }); ledger.reconcile();
    vi.stubEnv(settings.webhookEnv, webhook('b'));
    const worker = new NotificationWorker({ store, projectId: 'a', settings, multiProject: false, check() {}, transport }); workers.push(worker);
    await worker.tick(); expect(ledger.list()).toMatchObject([{ status: 'blocked', reason: 'recipient_changed' }]);
    for (const target of ['chain', 'state', 'pending', 'symlink'] as const) {
      const bad = project(); const candidate = setup(bad, transport);
      if (target === 'chain') writeFileSync(bad.path('events.jsonl'), readFileSync(bad.path('events.jsonl'), 'utf8').replace('private-title', 'tampered'));
      if (target === 'state') writeFileSync(bad.path('changes', 'same', 'questions.json'), '[]');
      if (target === 'pending') writeFileSync(join(bad.root, '.git', 'specforge-write.pending.json'), '{}');
      if (target === 'symlink') {
        const file = bad.path('changes', 'same', 'questions.json');
        rmSync(file); symlinkSync(store.path('changes', 'same', 'questions.json'), file);
      }
      const before = readFileSync(bad.path('events.jsonl'), 'utf8');
      await candidate.worker.tick(); expect(candidate.worker.status().state).toBe('paused');
      expect(readFileSync(bad.path('events.jsonl'), 'utf8')).toBe(before);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('受理后源文件异常暂停结果记账，修复后仅落原结果，不伪造新尝试', async () => {
    const store = project(); const response = deferred<FeishuResponse>(); const transport = vi.fn(() => response.promise);
    const { worker, ledger } = setup(store, transport);
    const running = worker.tick(); await waitFor(() => transport.mock.calls.length === 1);
    const file = store.path('changes', 'same', 'questions.json'); const original = readFileSync(file, 'utf8');
    writeFileSync(file, '[]'); response.resolve(accepted()); await running;
    expect(worker.status()).toEqual({ state: 'paused', reason: 'result_pending' });
    expect(store.events().filter((event) => event.type === 'notification.accepted')).toHaveLength(0);
    writeFileSync(file, original); await worker.tick();
    expect(ledger.list()).toMatchObject([{ status: 'accepted', attempts: 1 }]);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('真实子进程强制退出与独占恢复', () => {
  for (const mode of ['queued', 'started', 'accepted-unrecorded', 'accepted-recorded']) {
    it(`${mode} 检查点 SIGKILL 后按账本恢复，不清历史或猜测成功`, async () => {
      const store = project(); credentials();
      const child = fork(join(import.meta.dirname, 'fixtures/notification-worker.ts'), [store.root, mode], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child);
      let errors = ''; child.stderr!.on('data', (chunk) => { errors += chunk; });
      const exited = once(child, 'exit');
      await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`worker 提前退出 ${errors}`); })]);
      expect(store.lockStatus().locked).toBe(false);
      if (mode === 'accepted-unrecorded') expect(existsSync(join(store.root, 'remote-marker'))).toBe(true);
      const transport = vi.fn(async () => accepted());
      const live = setup(store, transport); await live.worker.tick();
      expect(live.worker.status()).toEqual({ state: 'paused', reason: 'owner' });
      child.kill('SIGKILL'); await exited;
      await live.worker.tick();
      const record = live.ledger.list()[0]!;
      expect(record.status).toBe(mode === 'queued' || mode === 'accepted-recorded' ? 'accepted' : 'unknown');
      expect(record.attempts).toBe(1);
      expect(transport).toHaveBeenCalledTimes(mode === 'queued' ? 1 : 0);
      expect(verifyLog(store).ok).toBe(true);
      expect(errors).toBe('');
    });
  }
});
