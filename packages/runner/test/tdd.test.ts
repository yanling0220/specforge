import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changedTestFiles, headSha, isAncestor, runTdd, tddCommand } from '../src/index.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const g = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

function commit(dir: string, files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'c');
  return headSha(dir);
}

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sf-tdd-'));
  dirs.push(dir);
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.email', 't@t');
  g(dir, 'config', 'user.name', 't');
  commit(dir, files);
  return dir;
}

// 用 shell 模拟“只跑指定测试”：每个测试文件里写着它要检查存在的文件
const config = { command: 'for f in {files}; do test -f "$(cat "$f")" || exit 1; done' };
const testGlobs = ['*.test'];

describe('runTdd', () => {
  it('{files} 替换为加引号的文件列表；没有占位符时追加在末尾', () => {
    expect(tddCommand('node --test {files}', ['a b.test', "it's.test"])).toBe(`node --test 'a b.test' 'it'\\''s.test'`);
    expect(tddCommand('pytest', ['t.py'])).toBe(`pytest 't.py'`);
  });

  it('先红后绿：新测试在 base 上失败，在任务 commit 上通过', () => {
    const dir = repo({ 'old.test': 'readme', readme: 'x' });
    const base = headSha(dir);
    const sha = commit(dir, { 'x.test': 'x.js', 'x.js': '1' });
    const ev = runTdd({ repo: dir, taskId: 'T-1', base, sha, testGlobs, config });
    expect(ev.testFiles).toEqual(['x.test']);
    expect(ev.red.test!.exitCode).not.toBe(0);
    expect(ev.green.test!.exitCode).toBe(0);
    expect(ev.red.test!.command).toBe(`for f in 'x.test'; do test -f "$(cat "$f")" || exit 1; done`);
    expect(g(dir, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    expect(isAncestor(dir, base, sha)).toBe(true);
    expect(isAncestor(dir, sha, base)).toBe(false);
  });

  it('测试一开始就通过：RED 退出码为 0', () => {
    const dir = repo({ readme: 'x' });
    const base = headSha(dir);
    const sha = commit(dir, { 'x.test': 'readme' });
    const ev = runTdd({ repo: dir, taskId: 'T-1', base, sha, testGlobs, config });
    expect(ev.red.test!.exitCode).toBe(0);
  });

  it('没有新增或修改测试时不运行；删除的测试不计入；准备命令失败时不跑测试', () => {
    const dir = repo({ 'old.test': 'readme', readme: 'x' });
    const base = headSha(dir);
    g(dir, 'rm', '-q', 'old.test');
    const sha = commit(dir, { 'x.js': '1' });
    expect(changedTestFiles(dir, base, sha, testGlobs)).toEqual([]);
    const ev = runTdd({ repo: dir, taskId: 'T-1', base, sha, testGlobs, config });
    expect(ev.red).toEqual({});
    expect(ev.green).toEqual({});

    const sha2 = commit(dir, { 'y.test': 'x.js' });
    const failedSetup = runTdd({ repo: dir, taskId: 'T-2', base: sha, sha: sha2, testGlobs, config: { ...config, setup: 'exit 3' } });
    expect(failedSetup.red.setup!.exitCode).toBe(3);
    expect(failedSetup.red.test).toBeUndefined();
  });
});
