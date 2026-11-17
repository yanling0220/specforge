import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseNotificationConfig } from '@specforge/core';
import { NotificationLedger, verifyLog, type Store } from '@specforge/store';
import {
  startMultiProjectServer, startServer,
  type RunningMultiProjectServer, type RunningServer,
} from '../src/server.ts';
import type { FeishuTransport } from '../src/feishu.ts';
import { notificationProject, notificationSettings, webhook } from './fixtures/notification-project.ts';

const roots: string[] = [];
const servers: (RunningServer | RunningMultiProjectServer)[] = [];
const mount = '/console/team';

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function project(): Store {
  const store = notificationProject();
  roots.push(store.root);
  return store;
}

function frontend(store: Store): string {
  const directory = join(store.root, 'web');
  mkdirSync(join(directory, 'assets'), { recursive: true });
  writeFileSync(join(directory, 'index.html'), '<!doctype html><html><head><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"></head><body>SpecForge</body></html>');
  writeFileSync(join(directory, 'assets', 'app.js'), 'export const loaded = true;');
  writeFileSync(join(directory, 'assets', 'app.css'), 'body { color: black; }');
  return directory;
}

async function login(url: string): Promise<Response> {
  return fetch(url + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'dev', token: 'dev-token' }),
  });
}

function settings() {
  const entry = notificationSettings('a');
  vi.stubEnv(entry.webhookEnv, webhook('a'));
  vi.stubEnv(entry.signingSecretEnv, 'test-signing-secret');
  return entry;
}

describe('部署前缀的 HTTP 与通知绑定', () => {
  it('单项目只在配置前缀下暴露接口和资源，登录 Cookie 同时限定路径，GET 不写状态', async () => {
    const store = project();
    const before = store.events();
    const server = await startServer({ store, port: 0, pollMs: 60_000, basePath: mount, webDir: frontend(store) });
    servers.push(server);
    expect(new URL(server.url).pathname).toBe(mount);
    expect((await fetch(server.url + '/api/health')).status).toBe(200);
    const origin = new URL(server.url).origin;
    for (const path of ['/api/health', '/api/changes', '/assets/app.js', '/console/team-other/api/health']) {
      expect((await fetch(origin + path)).status).toBe(404);
    }
    const html = await fetch(server.url + '/').then((response) => response.text());
    expect(html).toContain('name="specforge-base-path" content="/console/team"');
    expect(html).toContain('src="/console/team/assets/app.js"');
    expect(html).toContain('href="/console/team/assets/app.css"');
    expect(await fetch(server.url + '/assets/app.js').then((response) => response.text())).toBe('export const loaded = true;');
    expect((await fetch(server.url + '/api/changes')).status).toBe(401);
    const authenticated = await login(server.url);
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get('set-cookie')).toContain('Path=/console/team');
    const cookie = authenticated.headers.get('set-cookie')!.split(';')[0]!;
    expect((await fetch(server.url + '/api/changes', { headers: { cookie } })).status).toBe(200);
    expect(store.events()).toEqual(before);
  });

  it('多项目在前缀下保持独立会话和 Cookie 路径，未知入口不返回项目目录', async () => {
    const a = project();
    const b = project();
    const before = [a.events(), b.events()];
    const server = await startMultiProjectServer({
      projects: [{ id: 'a', root: a.root }, { id: 'b', root: b.root }],
      port: 0, pollMs: 60_000, basePath: mount, webDir: frontend(a),
    });
    servers.push(server);
    expect(await fetch(server.url + '/api/health').then((response) => response.json())).toMatchObject({ mode: 'multi-project' });
    const html = await fetch(server.url + '/p/a/').then((response) => response.text());
    expect(html).toContain('name="specforge-base-path" content="/console/team"');
    expect(html).toContain('src="/console/team/assets/app.js"');
    expect((await fetch(new URL(server.url).origin + '/p/a/api/changes')).status).toBe(404);
    expect((await fetch(server.url + '/p/b/api/changes')).status).toBe(401);
    const authenticated = await login(server.url + '/p/a');
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get('set-cookie')).toContain('Path=/console/team/p/a');
    const cookie = authenticated.headers.get('set-cookie')!.split(';')[0]!;
    const result = await fetch(server.url + '/p/a/api/project', { headers: { cookie } });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ id: 'a' });
    for (const candidate of [cookie, cookie.replace('sf_session_a=', 'sf_session_b=')]) {
      expect((await fetch(server.url + '/p/b/api/changes', { headers: { cookie: candidate } })).status).toBe(401);
    }
    expect((await fetch(server.url + '/p/missing/')).status).toBe(200);
    expect((await fetch(server.url + '/p/missing/api/changes')).status).toBe(404);
    expect([a.events(), b.events()]).toEqual(before);
  });

  it('无效部署前缀在服务监听前拒绝，不改变业务事件', async () => {
    const a = project();
    const b = project();
    const before = [a.events(), b.events()];
    for (const basePath of ['//console', '/console/..', '/console/%2e%2e', '/console?token=x', '/console//team']) {
      await expect(startServer({ store: a, port: 0, basePath })).rejects.toThrow(/部署前缀/);
      await expect(startMultiProjectServer({
        projects: [{ id: 'a', root: a.root }, { id: 'b', root: b.root }], port: 0, basePath,
      })).rejects.toThrow(/部署前缀/);
    }
    expect([a.events(), b.events()]).toEqual(before);
  });

  it('通知链接前缀与服务不一致时只阻塞通知，原项目仍可登录', async () => {
    const store = project();
    const transport = vi.fn<FeishuTransport>(async () => ({ status: 200, code: 0, retryAfter: null }));
    const server = await startServer({
      store, port: 0, pollMs: 60_000, basePath: mount,
      notifications: parseNotificationConfig({ version: 1, projects: [settings()] }),
      notificationTransport: transport,
    });
    servers.push(server);
    await server.notifications!.tick();
    expect(transport).not.toHaveBeenCalled();
    expect(new NotificationLedger(store, { projectId: 'a' }).list()).toMatchObject([
      { status: 'blocked', reason: 'configuration', attempts: 0 },
    ]);
    expect((await login(server.url)).status).toBe(200);
    expect(verifyLog(store).ok).toBe(true);
  });

  it('匹配前缀的最小通知保留单项目深链接，注入受理后不重复发送或改变问题', async () => {
    const store = project();
    const before = readFileSync(store.path('changes', 'same', 'questions.json'), 'utf8');
    const entry = { ...settings(), publicBaseUrl: 'https://console.example.invalid' + mount };
    const transport = vi.fn<FeishuTransport>(async () => ({ status: 200, code: 0, retryAfter: null }));
    const server = await startServer({
      store, port: 0, pollMs: 60_000, basePath: mount,
      notifications: parseNotificationConfig({ version: 1, projects: [entry] }),
      notificationTransport: transport,
    });
    servers.push(server);
    await server.notifications!.tick();
    await server.notifications!.tick();
    expect(transport).toHaveBeenCalledTimes(1);
    const nodes = JSON.parse(transport.mock.calls[0]![1]).content.post.zh_cn.content.flat() as { tag: string; href?: string }[];
    expect(nodes.find((node) => node.tag === 'a')?.href).toBe('https://console.example.invalid/console/team/#/changes/same/analysis/Q-1');
    expect(new NotificationLedger(store, { projectId: 'a' }).list()).toMatchObject([{ status: 'accepted', attempts: 1 }]);
    expect(readFileSync(store.path('changes', 'same', 'questions.json'), 'utf8')).toBe(before);
    expect(verifyLog(store).ok).toBe(true);
  });
});
