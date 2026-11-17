import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { feishuCredentials } from '@specforge/core';
import { NotificationLedger, verifyLog } from '@specforge/store';
import { cmdNotify } from '../src/notifications.ts';
import { notificationProject, notificationSettings, webhook } from '../../server/test/fixtures/notification-project.ts';

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function project(id = 'a', enabled = true) {
  const store = notificationProject();
  roots.push(store.root);
  const settings = { ...notificationSettings(id), enabled };
  vi.stubEnv(settings.webhookEnv, webhook(id));
  vi.stubEnv(settings.signingSecretEnv, 'private-signing-secret');
  const file = join(store.root, 'notifications.json');
  writeFileSync(file, JSON.stringify({ version: 1, projects: [settings] }));
  const options = { file, projectId: id, as: 'dev:dev' };
  const ledger = new NotificationLedger(store, {
    projectId: id, enabled, route: feishuCredentials(settings, process.env).route,
  });
  return { store, settings, file, options, ledger };
}

describe('本地通知管理（T4.5d）', () => {
  it('关闭时预览数量、角色和脱敏消息，不写账本、业务文件或发送请求', () => {
    const { store, options, ledger } = project('a', false);
    const before = readFileSync(store.path('events.jsonl'), 'utf8');
    const questions = readFileSync(store.path('changes', 'same', 'questions.json'), 'utf8');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = cmdNotify(store, 'preview', { ...options, multiProject: true });
    expect(result).toMatchObject({
      enabled: false, configuration: 'ready', pendingCount: 1, eligibleAfterEnableCount: 1,
      candidates: [{
        existing: false, kind: 'question-confirmation', role: 'product', revision: 1,
        message: { mentions: ['pm'], links: ['https://console.example.invalid/p/a/#/changes/same/analysis/Q-1'] },
      }],
    });
    expect(JSON.stringify(result)).not.toMatch(/private-|ou_a_pm|open[.]feishu|repositoryId/);
    expect(ledger.list()).toEqual([]);
    expect(readFileSync(store.path('events.jsonl'), 'utf8')).toBe(before);
    expect(readFileSync(store.path('changes', 'same', 'questions.json'), 'utf8')).toBe(questions);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('状态和预览保持 started，不擅自恢复为 unknown；change 筛选只读', () => {
    const { store, options, ledger } = project();
    const key = ledger.reconcile()[0]!.key;
    ledger.prepare(key);
    const events = store.events();
    expect(cmdNotify(store, 'status', options)).toMatchObject({
      enabled: true, count: 1, records: [{ key, status: 'started', attempts: 1, round: 0, attemptsThisRound: 1 }],
    });
    expect(cmdNotify(store, 'preview', options)).toMatchObject({ pendingCount: 1, eligibleAfterEnableCount: 0 });
    expect(cmdNotify(store, 'status', { ...options, changeId: 'missing' })).toMatchObject({ count: 0, records: [] });
    expect(store.events()).toEqual(events);
  });

  it('真实 CLI 参数解析保持预览只读，关闭状态不被显示为运行中', () => {
    const { store, file } = project('a', false);
    const before = store.events();
    const output = execFileSync(process.execPath, [
      join(import.meta.dirname, '../src/main.ts'),
      'notify', 'preview', 'same', '--notifications', file, '--project', 'a', '--multi-project',
    ], { cwd: store.root, encoding: 'utf8', stdio: 'pipe' });
    expect(JSON.parse(output)).toMatchObject({ enabled: false, pendingCount: 1, eligibleAfterEnableCount: 1 });
    expect(output).not.toMatch(/private-|ou_a_pm|open[.]feishu/);
    expect(store.events()).toEqual(before);
  });

  it('真实 CLI 重试需管理员、原因和 unknown 风险确认，只追加一条重试意图', () => {
    const { store, options, file, ledger } = project();
    const key = ledger.reconcile()[0]!.key;
    ledger.prepare(key);
    ledger.finish(key, 1, { kind: 'unknown' });
    const before = store.events();
    const reference = 'n-' + key.slice(0, 12);
    expect(() => cmdNotify(store, 'retry', { ...options, as: 'pm:product', reason: '已核对', acceptDuplicateRisk: true }, reference)).toThrow(/管理员/);
    expect(() => cmdNotify(store, 'retry', { ...options, reason: '已核对' }, reference)).toThrow(/重复消息风险/);
    expect(store.events()).toEqual(before);
    const output = execFileSync(process.execPath, [
      join(import.meta.dirname, '../src/main.ts'),
      'notify', 'retry', reference, '--notifications', file, '--project', 'a',
      '--as', 'dev:dev', '--reason', '已核对并接受重复风险', '--accept-duplicate-risk',
    ], { cwd: store.root, encoding: 'utf8', stdio: 'pipe' });
    expect(JSON.parse(output)).toMatchObject({ queued: true, record: { key, status: 'queued', attempts: 1, round: 1, attemptsThisRound: 0 } });
    expect(store.events().length).toBe(before.length + 1);
    expect(store.events().at(-1)).toMatchObject({ type: 'notification.retried', actor: { name: 'dev', role: 'dev' } });
    expect(ledger.list()[0]!.attempts).toBe(1);
    ledger.prepare(key);
    ledger.finish(key, 2, { kind: 'accepted' });
    expect(() => cmdNotify(store, 'retry', { ...options, reason: '再次通知' }, key)).toThrow(/已受理/);
    expect(verifyLog(store).ok).toBe(true);
  });

  it('项目和记录引用不能跨仓库复用，不回退到另一项目或默认路由', () => {
    const a = project('a');
    const b = project('b');
    const left = a.ledger.reconcile()[0]!;
    const right = b.ledger.reconcile()[0]!;
    const before = [a.store.events(), b.store.events()];
    expect(left.key).not.toBe(right.key);
    expect(() => cmdNotify(a.store, 'status', { ...a.options, projectId: 'b' })).toThrow(/没有指定项目/);
    writeFileSync(a.file, JSON.stringify({ version: 1, projects: [a.settings, b.settings] }));
    expect(() => cmdNotify(a.store, 'status', { ...a.options, projectId: 'b' })).toThrow(/显式迁移/);
    expect(() => cmdNotify(a.store, 'retry', { ...a.options, reason: '检查完成' }, right.key)).toThrow(/不存在或有歧义/);
    expect([a.store.events(), b.store.events()]).toEqual(before);
  });

  it('错误配置和缺失凭据显示 blocked，错误不暴露配置正文或凭据', () => {
    const { store, settings, options, file } = project();
    vi.stubEnv(settings.signingSecretEnv, '');
    expect(cmdNotify(store, 'preview', options)).toMatchObject({
      configuration: 'blocked', eligibleAfterEnableCount: 0,
      candidates: [{ status: 'blocked', reason: 'configuration', recipientStatus: 'configuration' }],
    });
    expect(() => cmdNotify(store, 'retry', { ...options, reason: '检查完成' }, 'a'.repeat(64))).toThrow(/配置或凭据不可用/);
    writeFileSync(file, '{"private-secret":');
    expect(() => cmdNotify(store, 'status', options)).toThrow(/^通知配置无效/);
    expect(store.events().some((event) => event.type.startsWith('notification.'))).toBe(false);
  });
});
