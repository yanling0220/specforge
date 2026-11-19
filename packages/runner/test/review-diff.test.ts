import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readReviewDiff, readReviewFileDiff, type ReviewDiffOptions } from '../src/index.ts';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sf-review-diff-'));
  dirs.push(dir);
  return dir;
}
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
}
function write(dir: string, path: string, text: string | Buffer): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}
function commit(dir: string): string {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fixture', '--allow-empty');
  return git(dir, 'rev-parse', 'HEAD');
}
function repo(files: Record<string, string | Buffer> = { 'file.txt': 'old\n' }): ReviewDiffOptions {
  const dir = temp();
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  return { repo: dir, projectBinding: 'project-A', changeId: 'change-A', baseSha: commit(dir) };
}
async function diff(options: ReviewDiffOptions, path: string) {
  const manifest = await readReviewDiff(options);
  const file = manifest.files.find((f) => f.path === path);
  expect(file, path).toBeDefined();
  return readReviewFileDiff({ ...options, targetSha: manifest.targetSha, fileId: file!.id });
}
function fingerprint(dir: string): string {
  const files: [string, string][] = [];
  const walk = (sub: string) => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = join(sub, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) files.push([rel, createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex')]);
    }
  };
  walk('');
  return JSON.stringify(files);
}
// Test-only executable wrapper: controls process boundaries without adding a
// production arbitrary-command injection option. Normal calls still use real Git.
function wrapGit(body: string): void {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const dir = temp();
  const script = `#!${process.execPath}\nconst {spawnSync} = require('node:child_process');\nconst args = process.argv.slice(2);\n${body}\nconst r = spawnSync(${JSON.stringify(realGit)}, args, {stdio: 'inherit'});\nprocess.exit(r.status ?? 1);\n`;
  writeFileSync(join(dir, 'git'), script, { mode: 0o755 });
  vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
}

describe('只读提交差异（T4.7a）', () => {
  it('增改删、旧新行号与三行上下文来自两个提交，忽略暂存和工作区', async () => {
    const options = repo({ 'file.txt': 'a\nb\nc\nd\ne\nf\ng\nh\n', 'deleted.txt': 'removed\n' });
    write(options.repo, 'file.txt', 'a\nb\nc\nNEW\ne\nf\ng\nh\n');
    rmSync(join(options.repo, 'deleted.txt'));
    write(options.repo, 'added.txt', 'added\n');
    const targetSha = commit(options.repo);
    write(options.repo, 'file.txt', 'WORKTREE SECRET\n');
    git(options.repo, 'add', 'file.txt');
    write(options.repo, 'file.txt', 'MORE DIRTY\n');
    write(options.repo, 'untracked.txt', 'not committed');
    const result = await readReviewDiff(options);
    expect(result).toMatchObject({ baseSha: options.baseSha, targetSha, baseIsAncestor: true });
    expect(result.files.map((f) => [f.path, f.status])).toEqual([['added.txt', 'A'], ['deleted.txt', 'D'], ['file.txt', 'M']]);
    const modified = await diff(options, 'file.txt');
    expect(modified.kind).toBe('text');
    if (modified.kind !== 'text') throw new Error('expected text');
    expect(modified.patch).toContain('@@ -1,7 +1,7 @@');
    expect(modified.patch).toContain('-d\n+NEW\n');
    expect(modified.patch).not.toContain('SECRET');
    expect(modified.patch).not.toContain('DIRTY');
    expect(await diff(options, 'added.txt')).toMatchObject({ kind: 'text', patch: expect.stringContaining('--- /dev/null') });
    expect(await diff(options, 'deleted.txt')).toMatchObject({ kind: 'text', patch: expect.stringContaining('+++ /dev/null') });
  });

  it('相同提交为空成功，缺失对象、非 SHA 或非仓库明确失败', async () => {
    const options = repo();
    expect(await readReviewDiff(options)).toMatchObject({ files: [], baseIsAncestor: true });
    await expect(readReviewDiff({ ...options, baseSha: 'f'.repeat(40) })).rejects.toMatchObject({ code: 'unavailable' });
    for (const baseSha of ['HEAD', '--output=secret', 'HEAD;touch oops', 'HEAD:path']) {
      await expect(readReviewDiff({ ...options, baseSha })).rejects.toMatchObject({ code: 'bad_arg' });
    }
    await expect(readReviewDiff({ ...options, repo: temp() })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('非祖先基线比较两个树，重命名按删增，不自动选择 merge-base', async () => {
    const options = repo({ 'original.txt': 'same content\n' });
    git(options.repo, 'checkout', '-qb', 'side');
    write(options.repo, 'side.txt', 'side\n');
    const baseSha = commit(options.repo);
    git(options.repo, 'checkout', '--detach', options.baseSha);
    renameSync(join(options.repo, 'original.txt'), join(options.repo, 'renamed.txt'));
    commit(options.repo);
    const result = await readReviewDiff({ ...options, baseSha });
    expect(result.baseIsAncestor).toBe(false);
    expect(result.files.map((f) => [f.path, f.status])).toEqual([['original.txt', 'D'], ['renamed.txt', 'A'], ['side.txt', 'D']]);
  });

  it('空格、中文、换行、制表符、HTML、前导短横线与 pathspec 都只选择字面文件', async () => {
    const options = repo();
    const names = ['a space.txt', '中文.txt', 'line\nbreak.txt', 'a\ttab.txt', '<script>.txt', '--name.txt', ':(glob)*', '*'];
    for (const name of names) write(options.repo, name, `unique:${JSON.stringify(name)}\n`);
    commit(options.repo);
    const manifest = await readReviewDiff(options);
    expect(manifest.files.map((f) => f.path).sort()).toEqual([...names].sort());
    for (const name of names) {
      const result = await diff(options, name);
      expect(result).toMatchObject({ kind: 'text', patch: expect.stringContaining(`+unique:${JSON.stringify(name)}`) });
      if (result.kind === 'text') expect((result.patch.match(/^diff --git /gm) ?? []).length).toBe(1);
    }
  });

  it('文件和目录互换时单文件 patch 排除子路径和内部文件', async () => {
    const options = repo({ 'before': 'old file\n', 'after/child.txt': 'old child\n' });
    rmSync(join(options.repo, 'before'));
    rmSync(join(options.repo, 'after'), { recursive: true });
    write(options.repo, 'before/child.txt', 'new child\n');
    write(options.repo, 'before/.specforge/users.json', 'internal data\n');
    write(options.repo, 'after', 'new file\n');
    commit(options.repo);
    for (const [path, content] of [['before', '-old file'], ['after', '+new file']] as const) {
      const result = await diff(options, path);
      expect(result).toMatchObject({ kind: 'text', patch: expect.stringContaining(content) });
      if (result.kind === 'text') {
        expect(result.patch).not.toMatch(/child|internal data/);
        expect(result.patch.match(/^diff --git /gm)).toHaveLength(1);
      }
    }
  });

  it('无法无损解码的 Git 路径明确不可展示，不使用替代字符读取其他文件', async () => {
    const options = repo({});
    // Construct the unusual path in Git objects, independent of filesystem / sandbox encoding.
    const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: options.repo, input: 'invalid path content' }).toString().trim();
    const entry = Buffer.concat([Buffer.from(`100644 blob ${oid}\tbad-`), Buffer.from([0xff, 0])]);
    const tree = execFileSync('git', ['mktree', '-z'], { cwd: options.repo, input: entry }).toString().trim();
    const targetSha = git(options.repo, 'commit-tree', tree, '-p', options.baseSha, '-m', 'invalid path');
    git(options.repo, 'update-ref', 'HEAD', targetSha);
    const manifest = await readReviewDiff(options);
    expect(manifest.files).toHaveLength(1);
    const file = manifest.files[0]!;
    expect(file.path).toBeUndefined();
    expect(await readReviewFileDiff({ ...options, targetSha, fileId: file.id })).toMatchObject({ kind: 'unavailable', reason: 'encoding' });
  });

  it('二进制仅元数据，非法 UTF-8 文本不可展示', async () => {
    const options = repo();
    write(options.repo, 'binary.bin', Buffer.from([0, 1, 2, 3]));
    write(options.repo, 'not-utf8.txt', Buffer.from([0xff, 10]));
    commit(options.repo);
    const binary = await diff(options, 'binary.bin');
    expect(binary).toMatchObject({ kind: 'binary', newBytes: 4 });
    expect(binary).not.toHaveProperty('patch');
    expect(await diff(options, 'not-utf8.txt')).toMatchObject({ kind: 'unavailable', reason: 'encoding' });
  });

  it('属性强制文本仍不输出二进制内容；大文本只读有界前缀后返回小 patch', async () => {
    const options = repo({ 'large.txt': `${'unchanged\n'.repeat(2000)}end\n` });
    write(options.repo, '.gitattributes', '*.bin diff\n');
    write(options.repo, 'forced.bin', Buffer.from([0, 65, 66, 67]));
    write(options.repo, 'large.txt', `${'unchanged\n'.repeat(2000)}new end\n`);
    commit(options.repo);
    expect(await diff(options, 'forced.bin')).toMatchObject({ kind: 'binary', newBytes: 4 });
    expect(await diff(options, 'large.txt')).toMatchObject({ kind: 'text', patch: expect.stringContaining('+new end') });
  });

  it('符号链接只读目标文本，gitlink 只读 SHA，类型变化和执行位单独识别', async () => {
    const options = repo({ 'file.txt': 'old\n', 'exec.sh': 'echo ok\n' });
    const outside = temp();
    write(outside, 'private.txt', 'DO NOT READ THIS CONTENT');
    symlinkSync(join(outside, 'private.txt'), join(options.repo, 'link'));
    rmSync(join(options.repo, 'file.txt'));
    symlinkSync('elsewhere', join(options.repo, 'file.txt'));
    chmodSync(join(options.repo, 'exec.sh'), 0o755);
    git(options.repo, 'add', '-A');
    git(options.repo, 'update-index', '--add', '--cacheinfo', `160000,${options.baseSha},sub`);
    git(options.repo, 'commit', '-qm', 'objects');
    const link = await diff(options, 'link');
    expect(link).toMatchObject({ kind: 'symlink', patch: expect.stringContaining('+/') });
    if (link.kind === 'symlink') expect(link.patch).not.toContain('DO NOT READ THIS CONTENT');
    expect(await diff(options, 'sub')).toMatchObject({ kind: 'submodule', file: { newOid: options.baseSha, newMode: '160000' } });
    expect(await diff(options, 'file.txt')).toMatchObject({ kind: 'type_change' });
    expect(await diff(options, 'exec.sh')).toMatchObject({ kind: 'text', patch: expect.stringContaining('new mode 100755') });
  });

  it('内部路径从清单和读取中排除，仍报告排除数量', async () => {
    const options = repo();
    write(options.repo, '.specforge/users.json', 'TOKEN HASH');
    write(options.repo, 'nested/.SpEcFoRgE/events.jsonl', 'PRIVATE EVENT');
    commit(options.repo);
    const result = await readReviewDiff(options);
    expect(result).toMatchObject({ excludedFiles: 2, files: [] });
    expect(JSON.stringify(result)).not.toContain('TOKEN');
    await expect(readReviewFileDiff({ ...options, targetSha: result.targetSha, fileId: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('文件 ID 稳定且绑定仓库、项目、change、提交，不能跨上下文读取', async () => {
    const options = repo();
    write(options.repo, 'new.txt', 'new\n');
    const targetSha = commit(options.repo);
    const original = await readReviewDiff(options);
    expect(await readReviewDiff(options)).toEqual(original);
    const fileId = original.files[0]!.id;
    for (const update of [{ projectBinding: 'B' }, { changeId: 'B' }, { baseSha: targetSha }]) {
      await expect(readReviewFileDiff({ ...options, ...update, targetSha, fileId })).rejects.toMatchObject({ code: 'not_found' });
    }
    const clone = temp();
    git(clone, 'clone', '-q', options.repo, '.');
    await expect(readReviewFileDiff({ ...options, repo: clone, targetSha, fileId })).rejects.toMatchObject({ code: 'not_found' });
    await expect(readReviewFileDiff({ ...options, targetSha, fileId: '../file.txt' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('HEAD 改变后旧文件请求返回 stale', async () => {
    const options = repo();
    write(options.repo, 'file.txt', 'v2\n');
    commit(options.repo);
    const snapshot = await readReviewDiff(options);
    write(options.repo, 'file.txt', 'v3\n');
    commit(options.repo);
    await expect(readReviewFileDiff({ ...options, targetSha: snapshot.targetSha, fileId: snapshot.files[0]!.id })).rejects.toMatchObject({ code: 'review_stale' });
  });

  it('忽略 replace 对象和自定义 diff 输出标记，完整 SHA 指向原提交内容', async () => {
    const options = repo();
    write(options.repo, 'file.txt', 'actual\n');
    const target = commit(options.repo);
    write(options.repo, 'file.txt', 'replacement secret\n');
    const replacement = commit(options.repo);
    git(options.repo, 'replace', target, replacement);
    git(options.repo, 'update-ref', 'HEAD', target);
    git(options.repo, 'config', 'diff.outputIndicatorNew', 'X');
    git(options.repo, 'config', 'diff.noprefix', 'true');
    const result = await diff(options, 'file.txt');
    expect(result).toMatchObject({ kind: 'text', patch: expect.stringContaining('+actual') });
    if (result.kind === 'text') {
      expect(result.patch).toContain('+++ b/file.txt');
      expect(result.patch).not.toContain('replacement secret');
    }
  });

  it('SHA-256 仓库保留完整 64 位提交和 blob 标识', async () => {
    const dir = temp();
    git(dir, 'init', '-q', '--object-format=sha256');
    git(dir, 'config', 'user.name', 'test');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'config', 'commit.gpgsign', 'false');
    write(dir, 'file.txt', 'before\n');
    const baseSha = commit(dir);
    write(dir, 'file.txt', 'after\n');
    const targetSha = commit(dir);
    const options = { repo: dir, projectBinding: 'sha256', changeId: 'change', baseSha };
    const snapshot = await readReviewDiff(options);
    expect(snapshot.targetSha).toBe(targetSha);
    expect(snapshot.files[0]!.newOid).toHaveLength(64);
    expect(await diff(options, 'file.txt')).toMatchObject({ kind: 'text', patch: expect.stringContaining('+after') });
  });

  it('读取期间外部 HEAD 变化不能返回混合快照', async () => {
    const options = repo();
    write(options.repo, 'file.txt', 'v2\n');
    const previous = commit(options.repo);
    write(options.repo, 'file.txt', 'v3\n');
    commit(options.repo);
    wrapGit(`if (args.includes('diff-tree')) spawnSync(${JSON.stringify(execFileSync('which', ['git'], { encoding: 'utf8' }).trim())}, ['update-ref', 'HEAD', ${JSON.stringify(previous)}], {stdio: 'ignore'});`);
    await expect(readReviewDiff(options)).rejects.toMatchObject({ code: 'review_stale' });
  });

  it('清单条数、清单字节、blob 和 patch 上限不返回截断成功', async () => {
    const options = repo();
    write(options.repo, 'one.txt', 'one\n');
    write(options.repo, 'two.txt', `${'large line\n'.repeat(100)}`);
    commit(options.repo);
    await expect(readReviewDiff({ ...options, limits: { maxFiles: 1 } })).rejects.toMatchObject({ code: 'too_large' });
    await expect(readReviewDiff({ ...options, limits: { manifestBytes: 50 } })).rejects.toMatchObject({ code: 'too_large' });
    const snapshot = await readReviewDiff(options);
    const fileId = snapshot.files.find((f) => f.path === 'two.txt')!.id;
    for (const limits of [{ patchBytes: 100 }, { blobBytes: 100 }]) {
      await expect(readReviewFileDiff({ ...options, limits, targetSha: snapshot.targetSha, fileId })).rejects.toMatchObject({ code: 'too_large' });
    }
    await expect(readReviewDiff({ ...options, limits: { maxFiles: 1001 } })).rejects.toMatchObject({ code: 'bad_arg' });
  });

  it('超时终止 Git 子进程，不挂起或返回空成功', async () => {
    const options = repo();
    wrapGit("if (args.includes('diff-tree')) { require('node:fs').writeFileSync('timeout-started', 'yes'); setInterval(() => {}, 1000); return; }");
    await expect(readReviewDiff({ ...options, limits: { commandMs: 2000 } })).rejects.toMatchObject({ code: 'timeout' });
    expect(existsSync(join(options.repo, 'timeout-started'))).toBe(true);
  });

  it('累计请求预算在各个命令之间共享', async () => {
    const options = repo();
    wrapGit('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);');
    await expect(readReviewDiff({ ...options, limits: { commandMs: 1000, totalMs: 180 } })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('Git 失败和超量 stderr 不输出绝对路径或原始诊断', async () => {
    const options = repo();
    wrapGit("if (args.includes('diff-tree')) { require('node:fs').writeSync(2, '/private/SECRET/' + 'X'.repeat(70000)); process.exit(1); }");
    await expect(readReviewDiff(options)).rejects.toMatchObject({ code: 'too_large', message: '提交差异超过读取上限' });
  });

  it('不执行 external diff、textconv、工作区过滤器或 partial clone 下载', async () => {
    const options = repo();
    const sentinel = join(temp(), 'executed');
    const script = join(temp(), 'processor');
    writeFileSync(script, `#!/bin/sh\ntouch '${sentinel}'\nexit 1\n`, { mode: 0o755 });
    write(options.repo, '.gitattributes', '*.txt diff=custom filter=custom\n');
    write(options.repo, 'file.txt', 'changed\n');
    commit(options.repo);
    git(options.repo, 'config', 'diff.external', script);
    git(options.repo, 'config', 'diff.custom.command', script);
    git(options.repo, 'config', 'diff.custom.textconv', script);
    git(options.repo, 'config', 'core.fsmonitor', script);
    git(options.repo, 'config', 'filter.custom.clean', script);
    git(options.repo, 'config', 'filter.custom.process', script);
    expect(await diff(options, 'file.txt')).toMatchObject({ kind: 'text', patch: expect.stringContaining('+changed') });
    expect(existsSync(sentinel)).toBe(false);
    git(options.repo, 'config', 'remote.origin.promisor', 'true');
    await expect(readReviewDiff(options)).rejects.toMatchObject({ code: 'unavailable' });
    expect(existsSync(sentinel)).toBe(false);
  });

  it('继承的仓库、索引和配置环境变量不能改变读取来源；读取不修改任何仓库文件', async () => {
    const options = repo();
    const foreign = repo({ 'foreign.txt': 'foreign secret\n' });
    write(options.repo, 'file.txt', 'committed\n');
    commit(options.repo);
    write(options.repo, 'file.txt', 'staged\n');
    git(options.repo, 'add', 'file.txt');
    write(options.repo, 'file.txt', 'dirty\n');
    write(options.repo, '.specforge/events.jsonl', 'engine state\n');
    const before = fingerprint(options.repo);
    vi.stubEnv('GIT_DIR', join(foreign.repo, '.git'));
    vi.stubEnv('GIT_WORK_TREE', foreign.repo);
    vi.stubEnv('GIT_INDEX_FILE', join(temp(), 'bad-index'));
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'diff.external');
    vi.stubEnv('GIT_CONFIG_VALUE_0', '/missing/secret');
    const snapshot = await readReviewDiff(options);
    const result = await readReviewFileDiff({ ...options, targetSha: snapshot.targetSha, fileId: snapshot.files[0]!.id });
    expect(result).toMatchObject({ kind: 'text', patch: expect.stringContaining('+committed') });
    expect(JSON.stringify(result)).not.toContain('foreign secret');
    expect(fingerprint(options.repo)).toEqual(before);
  });
});
