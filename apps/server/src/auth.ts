import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { findUser, sha256 } from '@specforge/core';
import type { Store } from '@specforge/store';
import type { HumanRole } from '@specforge/shared';

// Web 登录（T4.1）。启用用户名册后，除登录接口与健康检查外的所有接口都需要会话。
// 会话只保存在内存中；每次请求都回到名册核对：用户被停用或令牌被重置后，会话立即失效。

export const SESSION_COOKIE = 'sf_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

export interface SessionUser {
  name: string;
  roles: HumanRole[];
  admin: boolean;
}

interface Session {
  name: string;
  /** 登录时的令牌哈希：令牌重置后会话失效 */
  tokenHash: string;
  expiresAt: number;
}

export type AuthEnv = { Variables: { user?: SessionUser } };

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class Auth {
  private sessions = new Map<string, Session>();
  private failures = new Map<string, { count: number; resetAt: number }>();
  private store: Store;
  private now: () => number;

  constructor(store: Store, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  /** 是否需要登录：启用了用户名册 */
  required(): boolean {
    return !!this.store.users();
  }

  /** 校验令牌并创建会话；失败返回原因 */
  login(name: string, token: string, client: string): { sid: string; user: SessionUser } | { error: 'locked' | 'invalid' } {
    const key = `${client}|${name}`;
    const f = this.failures.get(key);
    if (f && f.resetAt > this.now() && f.count >= MAX_FAILURES) return { error: 'locked' };
    const u = this.store.users() && findUser(this.store.users()!, name);
    const hash = sha256(token);
    if (!u || u.disabled || !sameHash(u.tokenHash, hash)) {
      const cur = f && f.resetAt > this.now() ? f : { count: 0, resetAt: this.now() + FAILURE_WINDOW_MS };
      this.failures.set(key, { ...cur, count: cur.count + 1 });
      return { error: 'invalid' };
    }
    this.failures.delete(key);
    const sid = randomBytes(32).toString('base64url');
    this.sessions.set(sid, { name, tokenHash: u.tokenHash, expiresAt: this.now() + SESSION_TTL_MS });
    return { sid, user: { name: u.name, roles: u.roles, admin: u.admin } };
  }

  logout(sid: string | undefined): void {
    if (sid) this.sessions.delete(sid);
  }

  /** 会话对应的用户；过期、停用、令牌重置都返回 undefined 并清除会话 */
  user(sid: string | undefined): SessionUser | undefined {
    if (!sid) return undefined;
    const s = this.sessions.get(sid);
    if (!s) return undefined;
    const reg = this.store.users();
    const u = reg && findUser(reg, s.name);
    if (s.expiresAt <= this.now() || !u || u.disabled || u.tokenHash !== s.tokenHash) {
      this.sessions.delete(sid);
      return undefined;
    }
    return { name: u.name, roles: u.roles, admin: u.admin };
  }

  /** 需要登录的接口：未登录返回 401 */
  guard(): MiddlewareHandler<AuthEnv> {
    return async (c, next) => {
      if (this.required()) {
        const user = this.user(getCookie(c, SESSION_COOKIE));
        if (!user) return c.json({ error: { code: 'unauthorized', message: '需要登录' } }, 401);
        c.set('user', user);
      }
      await next();
    };
  }
}

function clientOf(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'local';
}

/** 登录相关接口 */
export function mountAuthRoutes(app: import('hono').Hono<AuthEnv>, auth: Auth): void {
  app.get('/api/auth/me', (c) => {
    const required = auth.required();
    return c.json({ required, user: required ? (auth.user(getCookie(c, SESSION_COOKIE)) ?? null) : null });
  });

  app.post('/api/auth/login', async (c) => {
    // 只接受 JSON：跨站表单无法发送，配合 SameSite=Strict 防 CSRF
    if (!c.req.header('content-type')?.startsWith('application/json')) {
      return c.json({ error: { code: 'bad_request', message: '需要 application/json' } }, 415);
    }
    if (!auth.required()) return c.json({ error: { code: 'no_registry', message: '项目还没有启用用户名册，不需要登录' } }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; token?: unknown };
    if (typeof body.name !== 'string' || typeof body.token !== 'string') {
      return c.json({ error: { code: 'bad_request', message: '需要 name 与 token' } }, 400);
    }
    const r = auth.login(body.name, body.token, clientOf(c));
    if ('error' in r) {
      return r.error === 'locked'
        ? c.json({ error: { code: 'locked', message: '失败次数过多，请 10 分钟后再试' } }, 429)
        : c.json({ error: { code: 'invalid', message: '用户名或令牌不正确' } }, 401);
    }
    setCookie(c, SESSION_COOKIE, r.sid, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: SESSION_TTL_MS / 1000 });
    return c.json({ user: r.user });
  });

  app.post('/api/auth/logout', (c) => {
    auth.logout(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });
}
