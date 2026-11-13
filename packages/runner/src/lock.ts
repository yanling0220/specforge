import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ForgeError } from '@specforge/core';
import { git } from './git.ts';

interface Owner { pid: number; token: string; startedAt: string }
interface Lease { directory: string; active: boolean; parent?: Lease }
const leases = new AsyncLocalStorage<Lease>();

export function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(descriptor, content);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function repositoryLockDir(root: string): string {
  return join(realpathSync(resolve(root, git(root, ['rev-parse', '--git-common-dir']))), 'specforge-write.lock');
}

function ownerOf(directory: string): Owner | undefined {
  try {
    const owner = JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8'));
    if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string') return owner;
  } catch {}
  return undefined;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function lockStatus(directory: string) {
  const exists = existsSync(directory);
  const owner = exists ? ownerOf(directory) : undefined;
  return { locked: exists, owner: owner ?? null, alive: owner ? alive(owner.pid) : null, recoveryClaimed: existsSync(join(directory, 'recovery')) };
}

export function withRepositoryLock<Result>(directory: string, operation: () => Result, recover = false): Result {
  const inherited = leases.getStore();
  for (let current = inherited; current; current = current.parent) {
    if (current.active && current.directory === directory && !recover) return operation();
  }
  let claimedRecovery = false;
  try {
    mkdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const status = lockStatus(directory);
    if (!recover || !status.owner || status.alive || status.recoveryClaimed) {
      const abandoned = !!status.owner && status.alive === false;
      throw new ForgeError(abandoned ? 'recovery_required' : 'write_busy', abandoned ? '仓库保留中断锁，请运行 sf lock status 并按恢复文档处理' : '仓库正在执行其他操作，请稍后重试');
    }
    try { mkdirSync(join(directory, 'recovery')); } catch {
      throw new ForgeError('recovery_required', '已有恢复操作，请先核对 sf lock status');
    }
    claimedRecovery = true;
  }
  const lease: Lease = { directory, active: true, parent: inherited };
  const owner: Owner = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() };
  if (!claimedRecovery) atomicWrite(join(directory, 'owner.json'), JSON.stringify(owner));
  const release = (success: boolean) => {
    lease.active = false;
    if (!claimedRecovery && ownerOf(directory)?.token !== owner.token) throw new ForgeError('recovery_required', '持有的仓库锁已被外部替换，拒绝解除');
    if (claimedRecovery && !success) rmSync(join(directory, 'recovery'), { recursive: true, force: true });
    else rmSync(directory, { recursive: true });
  };
  return leases.run(lease, () => {
    let result: Result;
    try { result = operation(); } catch (error) { release(false); throw error; }
    if (result instanceof Promise) return result.then((value) => { release(true); return value; }, (error) => { release(false); throw error; }) as Result;
    release(true);
    return result;
  });
}
