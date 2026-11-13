import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

/** 不抛异常的版本，返回退出码 */
export function gitTry(cwd: string, args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: git(cwd, args) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '').trimEnd() };
  }
}

export function headSha(cwd: string): string {
  return git(cwd, ['rev-parse', 'HEAD']);
}

export function repoRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

/** 工作区是否有未提交的改动；.specforge/ 是引擎自己写的状态，不计入 */
export function isDirty(cwd: string): boolean {
  return git(cwd, ['status', '--porcelain', '--', '.', ':(exclude).specforge']).length > 0;
}

export function changedFiles(cwd: string, from: string, to: string): string[] {
  const out = git(cwd, ['diff', '--name-only', `${from}..${to}`]);
  return out ? out.split('\n') : [];
}

export function diffText(cwd: string, from: string, to: string): string {
  return git(cwd, ['diff', '--unified=0', `${from}..${to}`]);
}

/** 在指定 commit 的树中查找包含 needle 的文件（不需要检出） */
export function grepFiles(cwd: string, sha: string, needle: string): string[] {
  const { code, out } = gitTry(cwd, ['grep', '-l', '-F', needle, sha]);
  if (code !== 0 || !out) return [];
  return out.split('\n').map((l) => l.slice(sha.length + 1));
}

/** 工作区指纹：HEAD + 已跟踪文件改动 + 未跟踪文件列表。只读 agent 运行前后必须一致 */
export function workspaceFingerprint(cwd: string): string {
  return [headSha(cwd), git(cwd, ['status', '--porcelain', '--untracked-files=all']), git(cwd, ['diff', 'HEAD'])].join('\n\0\n');
}

export function diffStat(cwd: string, from: string, to: string): string {
  return git(cwd, ['diff', '--stat', `${from}..${to}`]);
}

export function fullDiff(cwd: string, from: string, to: string): string {
  return git(cwd, ['diff', `${from}..${to}`]);
}

/** 在临时目录创建指向 sha 的分离 worktree */
export function createWorktree(repo: string, sha: string, prefix = 'specforge-wt-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(repo, ['worktree', 'add', '--detach', dir, sha]);
  return dir;
}

export function removeWorktree(repo: string, dir: string): void {
  gitTry(repo, ['worktree', 'remove', '--force', dir]);
  rmSync(dir, { recursive: true, force: true });
  gitTry(repo, ['worktree', 'prune']);
}

/**
 * 把 worktree 中相对 base 的全部改动（含 agent 自己的提交、未跟踪文件）放进暂存区，
 * 返回改动的文件列表。HEAD 会被软重置回 base。
 */
export function stageAllChanges(dir: string, base: string): string[] {
  git(dir, ['reset', '--soft', base]);
  git(dir, ['add', '-A']);
  const out = git(dir, ['diff', '--cached', '--name-only', base]);
  return out ? out.split('\n') : [];
}

/** 指定 commit 中某目录下的全部文件（相对仓库根目录） */
export function listFilesAt(cwd: string, sha: string, dir: string): string[] {
  const { code, out } = gitTry(cwd, ['ls-tree', '-r', '--name-only', sha, '--', dir]);
  return code === 0 && out ? out.split('\n') : [];
}

/** 读取指定 commit 中的文件；不存在时返回 undefined */
export function readFileAt(cwd: string, sha: string, path: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${sha}:${path}`], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}
