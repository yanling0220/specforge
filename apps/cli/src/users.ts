import { addUser, disableUser, ForgeError, publicUsers, rotateToken, updateUser } from '@specforge/core';
import { newToken, type Store } from '@specforge/store';
import type { Actor } from '@specforge/shared';

// sf user …：用户名册管理（T4.1）。所有修改走 Store.mutateUsers，写入哈希链。

export interface UserCmdResult {
  lines: string[];
  /** 新生成的令牌（只返回这一次） */
  token?: string;
}

/** 当前调用者：名册为空时允许没有身份（初始化） */
function caller(store: Store, as?: string): Actor | undefined {
  const reg = store.users();
  if (!reg?.users.length) {
    try {
      return store.claimedIdentity(as);
    } catch {
      return undefined;
    }
  }
  return store.identity(as);
}

export function cmdUserAdd(store: Store, name: string, roles: string[], admin: boolean, as?: string): UserCmdResult {
  const by = caller(store, as);
  const bootstrap = !store.users()?.users.length;
  const { token, hash } = newToken();
  const now = new Date().toISOString();
  // 初始化时由新管理员本人记录
  const actor: Actor = by ?? { name, role: (roles[0] as Actor['role']) ?? 'dev' };
  const reg = store.mutateUsers(actor, 'user.added', (r) => addUser(r, { name, roles, admin }, hash, bootstrap ? undefined : by, now), { name, roles, admin });
  const u = reg.users.find((x) => x.name === name)!;
  return {
    token,
    lines: [
      `已添加用户 ${u.name}（${u.roles.join(', ')}${u.admin ? '，管理员' : ''}）${bootstrap ? '；用户名册已启用，此后身份必须在名册中' : ''}`,
      `Web 登录令牌（只显示这一次，请转交本人妥善保存）：${token}`,
    ],
  };
}

export function cmdUserList(store: Store): UserCmdResult {
  const reg = store.users();
  if (!reg) return { lines: ['还没有启用用户名册（兼容模式：身份自行声明）。sf user add <名字> --role dev --admin 启用'] };
  return {
    lines: publicUsers(reg).map(
      (u) => `${u.name.padEnd(16)} ${u.roles.join(',').padEnd(12)} ${u.admin ? '管理员' : ''}${u.disabled ? ` 已停用（${u.disabled.reason}）` : ''}`,
    ),
  };
}

export function cmdUserSet(store: Store, name: string, change: { roles?: string[]; admin?: boolean }, as?: string): UserCmdResult {
  if (!change.roles && change.admin === undefined) throw new ForgeError('bad_arg', '需要 --role 或 --admin / --no-admin');
  const by = store.identity(as);
  requireRegistry(store);
  const reg = store.mutateUsers(by, 'user.updated', (r) => updateUser(r, name, change, by), { name, ...change });
  const u = reg.users.find((x) => x.name === name)!;
  return { lines: [`${u.name}：${u.roles.join(', ')}${u.admin ? '，管理员' : ''}`] };
}

export function cmdUserToken(store: Store, name: string, as?: string): UserCmdResult {
  const by = store.identity(as);
  requireRegistry(store);
  const { token, hash } = newToken();
  store.mutateUsers(by, 'user.token_rotated', (r) => rotateToken(r, name, hash, by, new Date().toISOString()), { name });
  return { token, lines: [`已重置 ${name} 的登录令牌，旧令牌与已登录的会话立即失效`, `新令牌（只显示这一次）：${token}`] };
}

export function cmdUserDisable(store: Store, name: string, reason: string, as?: string): UserCmdResult {
  const by = store.identity(as);
  requireRegistry(store);
  store.mutateUsers(by, 'user.disabled', (r) => disableUser(r, name, reason, by, new Date().toISOString()), { name, reason });
  return { lines: [`已停用 ${name}；其已登录的会话立即失效，历史记录保留`] };
}

function requireRegistry(store: Store): void {
  if (!store.users()) throw new ForgeError('no_registry', '还没有启用用户名册：先 sf user add <名字> --role dev --admin');
}
