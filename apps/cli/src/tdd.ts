import { ForgeError, tddAttemptChecks } from '@specforge/core';
import { runTdd } from '@specforge/runner';
import type { Actor, CheckResult, TddEvidence } from '@specforge/shared';
import type { Store } from '@specforge/store';

/** 运行 G5 TDD 检查并记录证据；返回证据与未通过的检查项 */
export function checkTdd(
  store: Store,
  changeId: string,
  actor: Actor,
  target: { taskId: string; base: string; sha: string },
  log: (line: string) => void,
): { evidence: TddEvidence; failures: CheckResult[] } {
  const config = store.config();
  if (!config.tdd?.command) {
    throw new ForgeError('no_tdd', '.specforge/config.json 缺少 tdd.command（只跑指定测试的命令，如 "node --test {files}"），无法执行 G5 TDD 门');
  }
  log(`G5：在干净 worktree 中确认新测试先失败（RED）、实现后通过（GREEN）…`);
  const evidence = runTdd({
    repo: store.root,
    ...target,
    testGlobs: config.testGlobs,
    config: config.tdd,
    onStep: (phase, s) => log(`  ${phase.toUpperCase()} ${s.name}：退出码 ${s.timedOut ? '超时' : s.exitCode}（${s.durationMs}ms）`),
  });
  if (evidence.testFiles.length) log(`  测试文件：${evidence.testFiles.join(', ')}`);
  const failures = tddAttemptChecks(evidence).filter((c) => !c.passed);
  store.saveTddEvidence(changeId, evidence, actor, failures.length === 0);
  return { evidence, failures };
}
