import { readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationLedger, questionAction, verifyLog, type Store } from '@specforge/store';
import { startMultiProjectServer, startServer, type RunningMultiProjectServer, type RunningServer } from '../src/server.ts';
import { parseNotificationConfig } from '../src/notification-config.ts';
import type { FeishuTransport, FeishuResponse } from '../src/feishu.ts';
import { notificationProject, notificationSettings, webhook } from './fixtures/notification-project.ts';

const servers: (RunningServer | RunningMultiProjectServer)[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});
function project() { const store = notificationProject(); roots.push(store.root); return store; }
function settings(id = 'a') {
  const entry = notificationSettings(id);
  vi.stubEnv(entry.webhookEnv, webhook(id)); vi.stubEnv(entry.signingSecretEnv, `private-${id}-secret`);
  return entry;
}
const config = (entries: unknown[]) => parseNotificationConfig({ version: 1, projects: entries });
async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 9000;
  while (!predicate()) { if (Date.now() > end) throw new Error('等待服务通知超时'); await new Promise((resolve) => setTimeout(resolve, 25)); }
}
async function login(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'dev', token: 'dev-token' }) });
    // 登录不是业务修改；仅精确的仓库忙允许夹具重新登录。
    if (response.status !== 409 || attempt === 10) return response;
    const body = await response.clone().json();
    if (body.error?.code !== 'write_busy') return response;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('通知服务接入（注入传输，不连接真实 IM）', () => {
  it('单项目默认兼容：没有通知配置就没有传输、凭据读取或 notification 事件', async () => {
    const store = project(); const before = readFileSync(store.path('events.jsonl'), 'utf8');
    const transport = vi.fn<FeishuTransport>(async () => ({ status: 200, code: 0, retryAfter: null }));
    const server = await startServer({ store, port: 0, pollMs: 20, notificationTransport: transport }); servers.push(server);
    await server.tick();
    expect(server.notifications).toBeUndefined(); expect(transport).not.toHaveBeenCalled();
    expect(readFileSync(store.path('events.jsonl'), 'utf8')).toBe(before);
  });

  it('双项目慢 A 不阻塞 B 通知或 HTTP；相同账号 / Q / change 的凭据、@ 与链接分别绑定', async () => {
    const a = project(); const b = project();
    let finishA!: (response: FeishuResponse) => void;
    const slow = new Promise<FeishuResponse>((resolve) => { finishA = resolve; });
    const transport = vi.fn<FeishuTransport>(async (url) => url === webhook('a') ? slow : { status: 200, code: 0, retryAfter: null });
    const server = await startMultiProjectServer({ projects: [{ id: 'a', root: a.root }, { id: 'b', root: b.root }], notifications: config([settings('a'), settings('b')]), notificationTransport: transport, port: 0, pollMs: 30 }); servers.push(server);
    try {
      await waitFor(() => transport.mock.calls.length === 2);
      expect(a.lockStatus().locked).toBe(false);
      expect((await login(`${server.url}/p/a`)).status).toBe(200);
      expect((await login(`${server.url}/p/b`)).status).toBe(200);
      expect(new NotificationLedger(b, { projectId: 'b' }).list()[0]!.status).toBe('accepted');
      for (const id of ['a', 'b']) {
        const call = transport.mock.calls.find(([url]) => url === webhook(id))!;
        const body = JSON.parse(call[1]);
        expect(JSON.stringify(body)).toContain(`/p/${id}/#/changes/same/analysis/Q-1`);
        const mentions = body.content.post.zh_cn.content.flat().filter((node: { tag: string }) => node.tag === 'at');
        expect(mentions).toEqual([{ tag: 'at', user_id: `ou_${id}_pm` }]);
      }
    } finally { finishA({ status: 200, code: 0, retryAfter: null }); }
    await waitFor(() => a.events().some((event) => event.type === 'notification.accepted'));
    expect(verifyLog(a).ok).toBe(true); expect(verifyLog(b).ok).toBe(true);
  });

  it('A 的通知配置错误只阻塞 A 通知，项目仍可登录且 B 正常发送', async () => {
    const a = project(); const b = project();
    const transport = vi.fn<FeishuTransport>(async () => ({ status: 200, code: 0, retryAfter: null }));
    const server = await startMultiProjectServer({ projects: [{ id: 'a', root: a.root }, { id: 'b', root: b.root }], notifications: config([{ ...settings('a'), alias: '<invalid>' }, settings('b')]), notificationTransport: transport, port: 0, pollMs: 30 }); servers.push(server);
    await waitFor(() => transport.mock.calls.length === 1);
    expect(transport.mock.calls[0]![0]).toBe(webhook('b'));
    expect(new NotificationLedger(a, { projectId: 'a' }).list()).toMatchObject([{ status: 'blocked', reason: 'configuration', attempts: 0 }]);
    expect((await login(`${server.url}/p/a`)).status).toBe(200);
  });

  it('五秒扫描发现 server 离线轮询之外的 CLI 修订，旧 accepted 不重复，停止后不再发起新请求', async () => {
    const store = project(); const transport = vi.fn<FeishuTransport>(async () => ({ status: 200, code: 0, retryAfter: null }));
    const server = await startServer({ store, port: 0, pollMs: 60_000, notifications: config([settings()]), notificationTransport: transport }); servers.push(server);
    await waitFor(() => transport.mock.calls.length === 1);
    await server.notifications!.tick();
    questionAction(store, 'same', { name: 'dev', role: 'dev' }, 'Q-1', { kind: 'answer', text: 'offline-second' });
    await waitFor(() => transport.mock.calls.length === 2);
    await server.notifications!.tick();
    expect(new NotificationLedger(store, { projectId: 'a' }).list()).toMatchObject([{ status: 'accepted', attempts: 1 }, { status: 'accepted', attempts: 1 }]);
    await server.close(); servers.splice(servers.indexOf(server), 1);
    questionAction(store, 'same', { name: 'dev', role: 'dev' }, 'Q-1', { kind: 'answer', text: 'third' });
    await server.notifications!.tick(); expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.every(([, body]) => !body.includes('offline-second'))).toBe(true);
  });

  it('稳定 ID 不匹配和未登记项目拒绝接入，不回退到默认项目', async () => {
    const a = project(); const b = project();
    await expect(startServer({ store: a, port: 0, notifications: config([settings('a'), settings('b')]) })).rejects.toThrow(/恰好包含一个/);
    await expect(startServer({ store: a, port: 0, indexConfig: { backend: 'postgres', projectId: 'different', connectionStringEnv: 'MISSING' }, notifications: config([settings()]) })).rejects.toThrow(/项目 ID 必须一致/);
    await expect(startMultiProjectServer({ projects: [{ id: 'a', root: a.root }, { id: 'b', root: b.root }], port: 0, notifications: config([settings('c')]) })).rejects.toThrow(/未登记/);
    expect(a.events().some((event) => event.type.startsWith('notification.'))).toBe(false);
  });
});
