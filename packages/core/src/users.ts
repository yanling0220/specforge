import type { Actor, HumanRole, UserRecord, UserRegistry } from '@specforge/shared';
import { ForgeError } from './errors.ts';

// 用户名册与身份校验（T4.1），纯函数。
// 没有名册时为兼容模式：身份由使用者自行声明（旧行为）。
// 有名册后：身份必须是名册中未停用的用户，且声明的角色已授予该用户。

export const HUMAN_ROLES: HumanRole[] = ['dev', 'product'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export function emptyRegistry(): UserRegistry {
  return { version: 1, users: [] };
}

export function findUser(reg: UserRegistry, name: string): UserRecord | undefined {
  return reg.users.find((u) => u.name === name);
}

function parseRoles(roles: string[]): HumanRole[] {
  const out = [...new Set(roles.map((r) => r.trim()).filter(Boolean))];
  if (!out.length) throw new ForgeError('bad_role', '至少需要一个角色（dev / product）');
  const bad = out.filter((r) => !HUMAN_ROLES.includes(r as HumanRole));
  if (bad.length) throw new ForgeError('bad_role', `角色只能是 ${HUMAN_ROLES.join(' / ')}，收到 ${bad.join(', ')}（agent 不是人的角色）`);
  return out as HumanRole[];
}

function requireUser(reg: UserRegistry, name: string): UserRecord {
  const u = findUser(reg, name);
  if (!u) throw new ForgeError('unknown_user', `用户 ${name} 不在名册中`);
  return u;
}

/**
 * 管理用户的权限：名册为空时允许初始化（第一个用户必须是管理员），之后只有管理员可以。
 * by 为空表示调用方还没有身份（初始化时）。
 */
export function assertCanManageUsers(reg: UserRegistry, by: Actor | undefined): void {
  if (!reg.users.length) return;
  const u = by && findUser(reg, by.name);
  if (!u || u.disabled || !u.admin) throw new ForgeError('forbidden', '只有管理员可以管理用户');
}

export function addUser(
  reg: UserRegistry,
  input: { name: string; roles: string[]; admin?: boolean },
  tokenHash: string,
  by: Actor | undefined,
  now: string,
): UserRegistry {
  assertCanManageUsers(reg, by);
  if (!NAME_RE.test(input.name)) throw new ForgeError('bad_name', '用户名只能包含字母、数字、点、下划线和连字符，最长 32 个字符');
  if (findUser(reg, input.name)) throw new ForgeError('exists', `用户 ${input.name} 已存在`);
  if (!reg.users.length && !input.admin) throw new ForgeError('bootstrap', '名册中的第一个用户必须是管理员（--admin）');
  const user: UserRecord = {
    name: input.name,
    roles: parseRoles(input.roles),
    admin: !!input.admin,
    tokenHash,
    createdAt: now,
    createdBy: by?.name ?? input.name,
  };
  return { ...reg, users: [...reg.users, user] };
}

/** 修改角色或管理员标记；不能让名册失去最后一个可用的管理员 */
export function updateUser(reg: UserRegistry, name: string, change: { roles?: string[]; admin?: boolean }, by: Actor): UserRegistry {
  assertCanManageUsers(reg, by);
  requireUser(reg, name);
  const users = reg.users.map((u) =>
    u.name === name ? { ...u, ...(change.roles ? { roles: parseRoles(change.roles) } : {}), ...(change.admin !== undefined ? { admin: change.admin } : {}) } : u,
  );
  if (!users.some((u) => u.admin && !u.disabled)) throw new ForgeError('last_admin', '不能取消最后一个可用管理员的管理员权限');
  return { ...reg, users };
}

/** 重置令牌：管理员或本人 */
export function rotateToken(reg: UserRegistry, name: string, tokenHash: string, by: Actor, now: string): UserRegistry {
  const u = requireUser(reg, name);
  if (by.name !== name) assertCanManageUsers(reg, by);
  if (u.disabled) throw new ForgeError('disabled', `用户 ${name} 已停用`);
  return { ...reg, users: reg.users.map((x) => (x.name === name ? { ...x, tokenHash, tokenRotatedAt: now } : x)) };
}

export function disableUser(reg: UserRegistry, name: string, reason: string, by: Actor, now: string): UserRegistry {
  assertCanManageUsers(reg, by);
  const u = requireUser(reg, name);
  if (!reason.trim()) throw new ForgeError('reason_required', '停用用户必须填写原因');
  if (u.disabled) throw new ForgeError('disabled', `用户 ${name} 已停用`);
  const users = reg.users.map((x) => (x.name === name ? { ...x, disabled: { at: now, by: by.name, reason } } : x));
  if (!users.some((x) => x.admin && !x.disabled)) throw new ForgeError('last_admin', '不能停用最后一个可用的管理员');
  return { ...reg, users };
}

/**
 * 校验声明的身份。reg 为 undefined（兼容模式）时原样返回。
 * agent 角色不能由人声明：agent 的身份只由引擎在运行 agent 时生成。
 */
export function resolveIdentity(reg: UserRegistry | undefined, claimed: Actor): Actor {
  if (!reg) return claimed;
  const u = findUser(reg, claimed.name);
  if (!u) throw new ForgeError('unknown_user', `用户 ${claimed.name} 不在名册中（sf user list 查看）`);
  if (u.disabled) throw new ForgeError('disabled', `用户 ${claimed.name} 已停用：${u.disabled.reason}`);
  if (!u.roles.includes(claimed.role as HumanRole)) {
    throw new ForgeError('role_not_granted', `用户 ${claimed.name} 没有 ${claimed.role} 角色（已授予：${u.roles.join(', ')}）`);
  }
  return { name: u.name, role: claimed.role };
}

/** 代录确认 / 驳回的对象也必须是名册中拥有该角色的用户 */
export function checkProxySubject(reg: UserRegistry | undefined, subject: Actor): void {
  if (!reg) return;
  try {
    resolveIdentity(reg, subject);
  } catch (e) {
    throw new ForgeError('bad_proxy', `代录对象无效：${(e as Error).message}`);
  }
}

/** 名册的公开视图：不含令牌哈希 */
export function publicUsers(reg: UserRegistry): Omit<UserRecord, 'tokenHash'>[] {
  return reg.users.map(({ tokenHash: _, ...u }) => u);
}
