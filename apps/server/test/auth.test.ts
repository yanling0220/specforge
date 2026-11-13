import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addUser, disableUser, emptyRegistry, rotateToken, sha256 } from '@specforge/core';
import { defaultConfig, Store } from '@specforge/store';
import { createApp } from '../src/app.ts';
import { Auth } from '../src/auth.ts';
import { ForgeIndex } from '../src/index-db.ts';
import { startServer } from '../src/server.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(withUsers = true): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sf-auth-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, '.specforge', 'changes'), { recursive: true });
  writeFileSync(join(dir, '.specforge', 'config.json'), JSON.stringify(defaultConfig()));
  const store = new Store(dir);
  if (withUsers) {
    const yan = { name: 'yan', role: 'dev' as const };
    store.mutateUsers(yan, 'user.added', (r) => addUser(r, { name: 'yan', roles: ['dev'], admin: true }, sha256('tok-brian'), undefined, 'T'), {});
    store.mutateUsers(yan, 'user.added', (r) => addUser(r, { name: 'lily', roles: ['product'] }, sha256('tok-lily'), yan, 'T'), {});
  }
  return store;
}

function setup(store: Store, now = () => Date.now()) {
  const index = new ForgeIndex(store);
  const app = createApp(store, index, { auth: new Auth(store, now) });
  const login = (name: string, token: string) =>
    app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, token }) });
  const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;
  const get = (path: string, cookie?: string) => app.request(path, { headers: cookie ? { cookie } : {} });
  return { app, index, login, cookieOf, get };
}

describe('Web 登录（T4.1）', () => {
  it('未启用名册：无需登录', async () => {
    const { get, index } = setup(project(false));
    expect((await get('/api/changes')).status).toBe(200);
    expect(await (await get('/api/auth/me')).json()).toEqual({ required: false, user: null });
    index.close();
  });

  it('启用名册：未登录 401；用令牌登录得到 HttpOnly + SameSite=Strict 会话；退出后失效', async () => {
    const { get, login, cookieOf, index, app } = setup(project());
    expect((await get('/api/changes')).status).toBe(401);
    expect((await get('/api/health')).status).toBe(200);
    expect(await (await get('/api/auth/me')).json()).toEqual({ required: true, user: null });

    expect((await login('lily', 'wrong')).status).toBe(401);
    expect((await login('nobody', 'tok-lily')).status).toBe(401);
    const res = await login('lily', 'tok-lily');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { name: 'lily', roles: ['product'], admin: false } });
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const cookie = cookieOf(res);
    expect((await get('/api/changes', cookie)).status).toBe(200);
    expect(((await (await get('/api/auth/me', cookie)).json()) as { user: { name: string } }).user.name).toBe('lily');

    await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } });
    expect((await get('/api/changes', cookie)).status).toBe(401);
    index.close();
  });

  it('登录只接受 JSON（防跨站表单）', async () => {
    const { app, index } = setup(project());
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=lily&token=tok-lily' });
    expect(res.status).toBe(415);
    index.close();
  });

  it('停用用户或重置令牌后，已有会话立即失效', async () => {
    const store = project();
    const { get, login, cookieOf, index } = setup(store);
    const lily = cookieOf(await login('lily', 'tok-lily'));
    const yan = cookieOf(await login('yan', 'tok-brian'));
    const admin = { name: 'yan', role: 'dev' as const };
    store.mutateUsers(admin, 'user.token_rotated', (r) => rotateToken(r, 'yan', sha256('tok-brian-2'), admin, 'T'), {});
    expect((await get('/api/changes', yan)).status).toBe(401);
    expect((await login('yan', 'tok-brian')).status).toBe(401);
    expect((await login('yan', 'tok-brian-2')).status).toBe(200);
    store.mutateUsers(admin, 'user.disabled', (r) => disableUser(r, 'lily', '离职', admin, 'T'), {});
    expect((await get('/api/changes', lily)).status).toBe(401);
    expect((await login('lily', 'tok-lily')).status).toBe(401);
    index.close();
  });

  it('会话 12 小时过期；连续失败 5 次锁定 10 分钟', async () => {
    let now = 1_000_000;
    const { get, login, cookieOf, index } = setup(project(), () => now);
    const cookie = cookieOf(await login('lily', 'tok-lily'));
    now += 12 * 60 * 60 * 1000;
    expect((await get('/api/changes', cookie)).status).toBe(401);

    for (let i = 0; i < 5; i++) expect((await login('yan', 'bad')).status).toBe(401);
    expect((await login('yan', 'tok-brian')).status).toBe(429);
    now += 10 * 60 * 1000 + 1;
    expect((await login('yan', 'tok-brian')).status).toBe(200);
    index.close();
  });

  it('名册被篡改：拒绝登录与访问（失败即关闭）', async () => {
    const store = project();
    const { get, login, cookieOf, index } = setup(store);
    const cookie = cookieOf(await login('lily', 'tok-lily'));
    writeFileSync(store.path('users.json'), JSON.stringify({ ...emptyRegistry(), users: [] }));
    expect((await get('/api/changes', cookie)).status).toBe(400);
    expect((await login('lily', 'tok-lily')).status).toBe(400);
    index.close();
  });

  it('WebSocket 同样需要登录；没有名册时不允许监听非本机地址', async () => {
    const store = project();
    const server = await startServer({ store, port: 0 });
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(`${server.url}/ws`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
        req.on('response', (res) => resolve(res.statusCode));
        req.on('upgrade', () => resolve(101));
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(401);
    } finally {
      await server.close();
    }
    await expect(startServer({ store: project(false), host: '0.0.0.0', port: 0 })).rejects.toThrow(/只能监听本机/);
  });
});
