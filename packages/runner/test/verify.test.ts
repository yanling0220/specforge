import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acCoverage, antiCheat, headSha, runVerification } from '../src/index.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sf-runner-'));
  dirs.push(dir);
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  commit(dir, files);
  return dir;
}

function commit(dir: string, files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'c'], { cwd: dir });
  return headSha(dir);
}

describe('runner', () => {
  it('在干净 worktree 中执行，只验证已提交的内容', () => {
    const dir = repo({ 'ok.sh': 'exit 0' });
    writeFileSync(join(dir, 'ok.sh'), 'exit 1'); // 未提交的改动不应影响结果
    const ev = runVerification({
      repo: dir,
      steps: [
        { name: 'pass', command: 'sh ok.sh && echo hello' },
        { name: 'fail', command: 'echo boom >&2; exit 3' },
      ],
    });
    expect(ev.mainTreeDirty).toBe(true);
    expect(ev.steps.map((s) => [s.name, s.exitCode])).toEqual([['pass', 0], ['fail', 3]]);
    expect(ev.steps[0]!.outputTail).toContain('hello');
    expect(ev.steps[1]!.outputTail).toContain('boom');
    expect(execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);
  });

  it('AC 覆盖与防作弊扫描基于 commit 内容', () => {
    const dir = repo({ 'a.test.ts': "it('[AC-1] works', () => {})\n" });
    const base = headSha(dir);
    const sha = commit(dir, { 'a.test.ts': "it('[AC-1] works', () => {})\nit.skip('[AC-2] later', () => {})\n", 'vitest.config.ts': '' });
    const testGlobs = ['**/*.test.*'];
    expect(acCoverage(dir, sha, ['AC-1', 'AC-2', 'AC-3'], testGlobs)).toEqual({ 'AC-1': ['a.test.ts'], 'AC-2': ['a.test.ts'], 'AC-3': [] });
    const r = antiCheat(dir, base, sha, { skipPatterns: ['\\bit\\.skip\\('], testGlobs, protectedPaths: ['**/vitest.config.*'] });
    expect(r.skipHits.map((h) => h.file)).toEqual(['a.test.ts']);
    expect(r.protectedChanges).toEqual(['vitest.config.ts']);
  });
});
