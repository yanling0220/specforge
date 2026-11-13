import { execFileSync } from 'node:child_process';
import { ForgeError } from '@specforge/core';
import type { LogAnchor } from '@specforge/shared';
import { git, gitTry } from './git.ts';

export const LOG_ANCHOR_REF = 'refs/heads/specforge-audit';
const ANCHOR_FILE = 'anchor.json';

export interface GitLogAnchor extends LogAnchor {
  commit: string;
}

function anchorGit(root: string, args: string[], input?: string): string {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trimEnd();
}

export function readLogAnchors(root: string, trustedCommit?: string): GitLogAnchor[] {
  if (trustedCommit !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(trustedCommit)) {
    throw new ForgeError('bad_arg', '--anchor 必须是完整的 Git commit SHA');
  }
  const tip = gitTry(root, ['--no-replace-objects', 'rev-parse', '--verify', '--quiet', trustedCommit ?? LOG_ANCHOR_REF]);
  if (!trustedCommit && tip.code === 1) return [];
  if (tip.code !== 0) throw new ForgeError('anchor_invalid', '无法读取 Git 审计锚定');
  try {
    let previous: string | undefined;
    return anchorGit(root, ['rev-list', '--reverse', '--topo-order', '--parents', tip.out]).split('\n').map((line) => {
      const [commit, ...parents] = line.split(' ');
      if (!commit || parents.length !== (previous ? 1 : 0) || (previous && parents[0] !== previous)) {
        throw new Error('审计分支必须是独立的线性历史');
      }
      previous = commit;
      const anchor: unknown = JSON.parse(anchorGit(root, ['show', `${commit}:${ANCHOR_FILE}`]));
      if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) throw new Error('锚定记录格式无效');
      return { ...anchor as LogAnchor, commit };
    });
  } catch {
    throw new ForgeError('anchor_invalid', 'Git 审计历史或锚定记录损坏');
  }
}

export function writeLogAnchor(root: string, anchor: LogAnchor, previousCommit?: string): GitLogAnchor {
  if (gitTry(root, ['symbolic-ref', '-q', LOG_ANCHOR_REF]).code === 0) {
    throw new ForgeError('anchor_invalid', 'Git 审计分支不能是符号引用');
  }
  const blob = anchorGit(root, ['hash-object', '-w', '--stdin'], JSON.stringify(anchor, null, 2) + '\n');
  const tree = anchorGit(root, ['mktree'], `100644 blob ${blob}\t${ANCHOR_FILE}\n`);
  const commit = anchorGit(root, [
    '-c', 'user.name=SpecForge', '-c', 'user.email=specforge@users.noreply.github.com',
    'commit-tree', tree, ...(previousCommit ? ['-p', previousCommit] : []),
    '-m', `SpecForge audit: event #${anchor.seq} ${anchor.hash}`,
  ]);
  const empty = '0'.repeat(git(root, ['rev-parse', '--show-object-format']) === 'sha256' ? 64 : 40);
  try {
    anchorGit(root, ['update-ref', '--no-deref', LOG_ANCHOR_REF, commit, previousCommit ?? empty]);
  } catch {
    throw new ForgeError('anchor_conflict', '更新 Git 审计分支失败（可能有并发锚定），请重试');
  }
  return { ...anchor, commit };
}
