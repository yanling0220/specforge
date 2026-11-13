import { describe, expect, it } from 'vitest';
import type { Actor } from '@specforge/shared';
import { addUser, checkProxySubject, disableUser, emptyRegistry, publicUsers, resolveIdentity, rotateToken, updateUser } from '../src/index.ts';

const T = '2026-11-13T00:00:00Z';
const yan: Actor = { name: 'yan', role: 'dev' };
const boot = () => addUser(emptyRegistry(), { name: 'yan', roles: ['dev'], admin: true }, 'h-brian', undefined, T);

describe('用户名册', () => {
  it('初始化：第一个用户必须是管理员；之后只有管理员能加人', () => {
    expect(() => addUser(emptyRegistry(), { name: 'yan', roles: ['dev'] }, 'h', undefined, T)).toThrow(/第一个用户必须是管理员/);
    const reg = boot();
    expect(reg.users[0]).toMatchObject({ name: 'yan', roles: ['dev'], admin: true, tokenHash: 'h-brian', createdBy: 'yan' });
    const withLily = addUser(reg, { name: 'lily', roles: ['product'] }, 'h-lily', yan, T);
    expect(() => addUser(withLily, { name: 'eve', roles: ['dev'] }, 'h', { name: 'lily', role: 'product' }, T)).toThrow(/只有管理员/);
    expect(() => addUser(withLily, { name: 'eve', roles: ['dev'] }, 'h', undefined, T)).toThrow(/只有管理员/);
  });

  it('校验用户名、重复、角色（不能授予 agent）', () => {
    const reg = boot();
    expect(() => addUser(reg, { name: 'a b', roles: ['dev'] }, 'h', yan, T)).toThrow(/用户名只能/);
    expect(() => addUser(reg, { name: 'yan', roles: ['dev'] }, 'h', yan, T)).toThrow(/已存在/);
    expect(() => addUser(reg, { name: 'bot', roles: ['agent'] }, 'h', yan, T)).toThrow(/agent 不是人的角色/);
    expect(() => addUser(reg, { name: 'x', roles: [] }, 'h', yan, T)).toThrow(/至少需要一个角色/);
    expect(addUser(reg, { name: 'lily', roles: ['product', 'dev', 'product'] }, 'h', yan, T).users[1]!.roles).toEqual(['product', 'dev']);
  });

  it('身份校验：兼容模式原样返回；启用后必须在名册中、未停用、角色已授予', () => {
    expect(resolveIdentity(undefined, { name: 'anyone', role: 'product' })).toEqual({ name: 'anyone', role: 'product' });
    let reg = addUser(boot(), { name: 'lily', roles: ['product'] }, 'h', yan, T);
    expect(resolveIdentity(reg, { name: 'lily', role: 'product' })).toEqual({ name: 'lily', role: 'product' });
    expect(() => resolveIdentity(reg, { name: 'lily', role: 'dev' })).toThrow(/没有 dev 角色/);
    expect(() => resolveIdentity(reg, { name: 'lily', role: 'agent' })).toThrow(/没有 agent 角色/);
    expect(() => resolveIdentity(reg, { name: 'eve', role: 'dev' })).toThrow(/不在名册中/);
    reg = disableUser(reg, 'lily', '离职', yan, T);
    expect(() => resolveIdentity(reg, { name: 'lily', role: 'product' })).toThrow(/已停用：离职/);
    expect(() => checkProxySubject(reg, { name: 'lily', role: 'product' })).toThrow(/代录对象无效/);
    expect(() => checkProxySubject(undefined, { name: 'lily', role: 'product' })).not.toThrow();
  });

  it('不能失去最后一个可用管理员', () => {
    const reg = addUser(boot(), { name: 'lily', roles: ['product'] }, 'h', yan, T);
    expect(() => updateUser(reg, 'yan', { admin: false }, yan)).toThrow(/最后一个可用管理员/);
    expect(() => disableUser(reg, 'yan', '测试', yan, T)).toThrow(/最后一个可用的管理员/);
    const two = updateUser(reg, 'lily', { admin: true }, yan);
    expect(updateUser(two, 'yan', { admin: false }, yan).users.find((u) => u.name === 'yan')!.admin).toBe(false);
    expect(() => disableUser(reg, 'lily', ' ', yan, T)).toThrow(/必须填写原因/);
  });

  it('重置令牌：管理员或本人；公开视图不含令牌哈希', () => {
    const reg = addUser(boot(), { name: 'lily', roles: ['product'] }, 'h-old', yan, T);
    const lily: Actor = { name: 'lily', role: 'product' };
    expect(rotateToken(reg, 'lily', 'h-new', lily, T).users[1]).toMatchObject({ tokenHash: 'h-new', tokenRotatedAt: T });
    expect(() => rotateToken(reg, 'yan', 'h', lily, T)).toThrow(/只有管理员/);
    expect(publicUsers(reg).some((u) => 'tokenHash' in u)).toBe(false);
  });
});
