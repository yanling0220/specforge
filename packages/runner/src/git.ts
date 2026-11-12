import { execFileSync } from 'node:child_process';

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
