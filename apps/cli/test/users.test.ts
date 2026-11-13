import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '@specforge/core';
import { defaultConfig, Store } from '@specforge/store';
import { cmdUserAdd, cmdUserDisable, cmdUserList, cmdUserSet, cmdUserToken } from '../src/users.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sf-users-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, '.specforge', 'changes'), { recursive: true });
  writeFileSync(join(dir, '.specforge', 'config.json'), JSON.stringify(defaultConfig()));
  return new Store(dir);
}

describe('sf user（T4.1）', () => {
  it('未启用时为兼容模式；第一个用户初始化名册并成为管理员，令牌只保存哈希', () => {
    const store = project();
    expect(store.identity('anyone:product')).toEqual({ name: 'anyone', role: 'product' });
    expect(cmdUserList(store).lines[0]).toMatch(/还没有启用用户名册/);

    const r = cmdUserAdd(store, 'yan', ['dev'], true);
    expect(r.token).toMatch(/^sf_[A-Za-z0-9_-]{43}$/);
    const file = readFileSync(store.path('users.json'), 'utf8');
    expect(file).not.toContain(r.token!);
    expect(file).toContain(sha256(r.token!));
    // 事件中不含令牌和哈希
    const ev = store.events().at(-1)!;
    expect(ev).toMatchObject({ type: 'user.added', actor: { name: 'yan' }, payload: { name: 'yan', roles: ['dev'], admin: true } });
    expect(JSON.stringify(ev)).not.toContain(sha256(r.token!));

    // 启用后：身份必须在名册中
    expect(() => store.identity('anyone:product')).toThrow(/不在名册中/);
    expect(store.identity('yan:dev')).toEqual({ name: 'yan', role: 'dev' });
    expect(() => store.identity('yan:product')).toThrow(/没有 product 角色/);
  });

  it('只有管理员能加人、改角色、停用；本人可以重置自己的令牌', () => {
    const store = project();
    cmdUserAdd(store, 'yan', ['dev'], true);
    cmdUserAdd(store, 'lily', ['product'], false, 'yan:dev');
    expect(() => cmdUserAdd(store, 'eve', ['dev'], false, 'lily:product')).toThrow(/只有管理员/);
    expect(() => cmdUserSet(store, 'lily', { roles: ['dev'] }, 'lily:product')).toThrow(/只有管理员/);
    expect(cmdUserSet(store, 'lily', { roles: ['product', 'dev'] }, 'yan:dev').lines[0]).toBe('lily：product, dev');
    expect(cmdUserToken(store, 'lily', 'lily:dev').token).toMatch(/^sf_/);
    expect(() => cmdUserToken(store, 'yan', 'lily:dev')).toThrow(/只有管理员/);
    cmdUserDisable(store, 'lily', '离职', 'yan:dev');
    expect(() => store.identity('lily:dev')).toThrow(/已停用/);
    expect(cmdUserList(store).lines.find((l) => l.startsWith('lily'))).toMatch(/已停用（离职）/);
    expect(store.events().filter((e) => e.type.startsWith('user.')).map((e) => e.type)).toEqual([
      'user.added',
      'user.added',
      'user.updated',
      'user.token_rotated',
      'user.disabled',
    ]);
  });

  it('名册被绕过引擎修改或删除：拒绝使用（失败即关闭），包括身份校验', () => {
    const store = project();
    cmdUserAdd(store, 'yan', ['dev'], true);
    const f = store.path('users.json');
    const original = readFileSync(f, 'utf8');
    // 偷偷给自己加 product 角色
    writeFileSync(f, original.replace('"dev"', '"dev", "product"'));
    expect(store.usersOutOfBand()).toMatch(/被绕过引擎修改/);
    expect(() => store.identity('yan:product')).toThrow(/用户名册被绕过引擎修改/);
    // 删除名册也不能回到兼容模式
    unlinkSync(f);
    expect(() => store.identity('anyone:product')).toThrow(/文件缺失/);
    writeFileSync(f, original);
    expect(store.usersOutOfBand()).toBeUndefined();
    // 手写的名册（没有经过 sf user）不被采信
    const fresh = project();
    writeFileSync(fresh.path('users.json'), original);
    expect(() => fresh.identity('yan:dev')).toThrow(/不是通过 sf user 命令创建的/);
  });
});
