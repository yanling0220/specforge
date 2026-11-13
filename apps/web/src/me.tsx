import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Role } from '@specforge/shared';
import type { SessionUser } from './api.ts';
import { PROJECT_ID } from './api.ts';

// 当前登录用户与"以哪个角色操作"。没有登录（未启用用户名册）时为只读。

interface Me {
  user: SessionUser | null;
  role?: Role;
  setRole(role: Role): void;
  /** 可以写：已登录 */
  canWrite: boolean;
}

const Ctx = createContext<Me>({ user: null, setRole: () => {}, canWrite: false });

const KEY = 'specforge.role';

export function MeProvider({ user, children }: { user: SessionUser | null; children: ReactNode }) {
  const pick = () => {
    const saved = PROJECT_ID ? null : localStorage.getItem(KEY) as Role | null;
    return user ? (saved && user.roles.includes(saved) ? saved : user.roles[0]) : undefined;
  };
  const [role, setRoleState] = useState<Role | undefined>(pick);
  useEffect(() => setRoleState(pick()), [user?.name]);
  const setRole = (r: Role) => {
    if (!PROJECT_ID) localStorage.setItem(KEY, r);
    setRoleState(r);
  };
  return <Ctx.Provider value={{ user, role, setRole, canWrite: !!user && !!role }}>{children}</Ctx.Provider>;
}

export const useMe = () => useContext(Ctx);
