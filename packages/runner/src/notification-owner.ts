import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ForgeError } from '@specforge/core';
import { atomicWrite, repositoryLockDir, withRepositoryLock } from './lock.ts';

/** 长期所有权与短期仓库写锁分离；只有确定死亡的 owner 才能被接替。 */
export function claimNotificationWorker(root: string): { assert(): void; release(): void } {
  const writeLock = repositoryLockDir(root);
  const directory = join(dirname(writeLock), 'specforge-notify.lock');
  const file = join(directory, 'owner.json');
  const read = () => {
    try {
      const owner = JSON.parse(readFileSync(file, 'utf8'));
      if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string' && owner.token) return owner as { pid: number; token: string };
    } catch {}
    return undefined;
  };
  const owner = { pid: process.pid, token: randomUUID() };
  withRepositoryLock(writeLock, () => {
    if (existsSync(directory)) {
      const previous = read();
      if (!previous) throw new ForgeError('notification_owner', '通知 owner 不明，请停服务并按通知恢复文档处理');
      let dead = false;
      try { process.kill(previous.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (!dead) throw new ForgeError('notification_owner', '已有通知 worker，不能并行接管');
      rmSync(directory, { recursive: true });
    }
    mkdirSync(directory);
    atomicWrite(file, JSON.stringify(owner));
  });
  let active = true;
  const assert = () => {
    if (!active || read()?.token !== owner.token) throw new ForgeError('notification_owner', '通知 worker 所有权已失效');
  };
  return {
    assert,
    release() {
      assert();
      // 新 owner 只能在此目录删除后接替，释放不需要占业务写锁。
      rmSync(directory, { recursive: true });
      active = false;
    },
  };
}
