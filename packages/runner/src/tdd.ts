import { matchesAny } from '@specforge/core';
import type { StepEvidence, TddConfig, TddEvidence, TddRun } from '@specforge/shared';
import { createWorktree, git, removeWorktree } from './git.ts';
import { runStep } from './verify.ts';

export interface TddOptions {
  repo: string;
  taskId: string;
  /** 任务开始前的 commit */
  base: string;
  /** 任务的 commit */
  sha: string;
  testGlobs: string[];
  config: TddConfig;
  onStep?: (phase: 'red' | 'green', step: StepEvidence) => void;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** 把测试文件填入命令：替换 {files}，没有占位符则追加在末尾 */
export function tddCommand(template: string, files: string[]): string {
  const list = files.map(quote).join(' ');
  return template.includes('{files}') ? template.replaceAll('{files}', list) : `${template} ${list}`;
}

/** base..sha 中新增或修改的测试文件（删除的不算） */
export function changedTestFiles(repo: string, base: string, sha: string, testGlobs: string[]): string[] {
  const out = git(repo, ['diff', '--name-only', '--diff-filter=AMR', `${base}..${sha}`]);
  return (out ? out.split('\n') : []).filter((f) => matchesAny(f, testGlobs));
}

function runIn(dir: string, config: TddConfig, files: string[], onStep: (s: StepEvidence) => void): TddRun {
  const run: TddRun = {};
  if (config.setup) {
    run.setup = runStep(dir, { name: 'setup', command: config.setup, timeoutMs: config.timeoutMs });
    onStep(run.setup);
    if (run.setup.exitCode !== 0 || run.setup.timedOut) return run;
  }
  run.test = runStep(dir, { name: 'test', command: tddCommand(config.command, files), timeoutMs: config.timeoutMs });
  onStep(run.test);
  return run;
}

/**
 * G5 证据采集（P3：引擎亲自运行，不采信 agent 自述）：
 * RED  —— 在 base 的干净 worktree 中只放入任务的新测试文件，运行这些测试，应当失败；
 * GREEN —— 在任务 commit 的干净 worktree 中运行同一组测试，应当通过。
 */
export function runTdd(opts: TddOptions): TddEvidence {
  const startedAt = new Date().toISOString();
  const testFiles = changedTestFiles(opts.repo, opts.base, opts.sha, opts.testGlobs);
  let red: TddRun = {};
  let green: TddRun = {};
  if (testFiles.length) {
    const redDir = createWorktree(opts.repo, opts.base, 'specforge-red-');
    try {
      git(redDir, ['checkout', opts.sha, '--', ...testFiles]);
      red = runIn(redDir, opts.config, testFiles, (s) => opts.onStep?.('red', s));
    } finally {
      removeWorktree(opts.repo, redDir);
    }
    const greenDir = createWorktree(opts.repo, opts.sha, 'specforge-green-');
    try {
      green = runIn(greenDir, opts.config, testFiles, (s) => opts.onStep?.('green', s));
    } finally {
      removeWorktree(opts.repo, greenDir);
    }
  }
  return {
    id: `tdd-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${opts.taskId}-${opts.sha.slice(0, 7)}`,
    taskId: opts.taskId,
    base: opts.base,
    sha: opts.sha,
    testFiles,
    red,
    green,
    startedAt,
    finishedAt: new Date().toISOString(),
    host: { node: process.version, platform: process.platform },
  };
}

/** sha 是否在 head 的历史中（含 head 本身） */
export function isAncestor(repo: string, sha: string, head: string): boolean {
  try {
    git(repo, ['merge-base', '--is-ancestor', sha, head]);
    return true;
  } catch {
    return false;
  }
}
