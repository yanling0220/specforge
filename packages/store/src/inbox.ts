import { ForgeError, inboxItems, resolveIdentity } from '@specforge/core';
import { headSha } from '@specforge/runner';
import type { Actor, InboxItem } from '@specforge/shared';
import { verifyLog } from './audit.ts';
import { evaluateAll } from './engine.ts';
import { withStoreLock } from './store.ts';

/** 当前项目的人工收件箱；整个快照持同一仓库锁，不写已读状态或通知账本。 */
export const readInbox = withStoreLock(function readInbox(store, actor: Actor): InboxItem[] {
  const registry = store.users();
  if (!registry) throw new ForgeError('no_registry', '审批收件箱需要启用用户名册并登录');
  const identity = resolveIdentity(registry, actor);
  if (identity.role !== 'dev' && identity.role !== 'product') throw new ForgeError('bad_role', '审批收件箱仅供人类角色使用');
  const role = identity.role;
  if (!verifyLog(store).ok) throw new ForgeError('inbox_unavailable', '项目审计校验异常，暂不能读取审批收件箱');
  const sha = headSha(store.root);
  const now = new Date().toISOString();
  return store.listChanges().flatMap((id) => {
    const state = store.load(id);
    if (state.change.stage === 'delivered') return [];
    return inboxItems({
      ...state, gates: evaluateAll(store, state), headSha: sha, now,
    }, role);
  });
});
