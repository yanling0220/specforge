import { findAddedSkips, matchesAny } from '@specforge/core';
import { changedFiles, diffText, grepFiles } from './git.ts';

/** AC 编号 → 在该 commit 中引用它的测试文件 */
export function acCoverage(repo: string, sha: string, acIds: string[], testGlobs: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of acIds) {
    out[id] = grepFiles(repo, sha, `[${id}]`).filter((f) => matchesAny(f, testGlobs));
  }
  return out;
}

export interface AntiCheatResult {
  skipHits: { file: string; line: string; pattern: string }[];
  protectedChanges: string[];
}

export function antiCheat(
  repo: string,
  baseSha: string,
  sha: string,
  opts: { skipPatterns: string[]; testGlobs: string[]; protectedPaths: string[] },
): AntiCheatResult {
  if (baseSha === sha) return { skipHits: [], protectedChanges: [] };
  return {
    skipHits: findAddedSkips(diffText(repo, baseSha, sha), opts.skipPatterns, opts.testGlobs),
    protectedChanges: changedFiles(repo, baseSha, sha).filter((f) => matchesAny(f, opts.protectedPaths)),
  };
}
