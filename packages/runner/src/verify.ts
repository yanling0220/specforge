import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@specforge/core';
import type { StepEvidence, VerificationEvidence, VerifyStep } from '@specforge/shared';
import { git, headSha, isDirty } from './git.ts';

const TAIL_BYTES = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface VerifyOptions {
  repo: string;
  steps: VerifyStep[];
  /** 默认是当前 HEAD */
  sha?: string;
  onStep?: (step: StepEvidence) => void;
}

/**
 * 在从目标 commit 检出的干净 worktree 中依次执行验证步骤，采集证据（P3）。
 * 某一步失败后，后续步骤仍会执行，以便一次看到全部问题。
 */
export function runVerification(opts: VerifyOptions): VerificationEvidence {
  const sha = opts.sha ?? headSha(opts.repo);
  const startedAt = new Date().toISOString();
  const mainTreeDirty = isDirty(opts.repo);
  const dir = mkdtempSync(join(tmpdir(), 'specforge-verify-'));
  git(opts.repo, ['worktree', 'add', '--detach', dir, sha]);
  const steps: StepEvidence[] = [];
  try {
    for (const step of opts.steps) {
      const t0 = Date.now();
      const res = spawnSync('sh', ['-c', step.command], {
        cwd: dir,
        encoding: 'utf8',
        timeout: step.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, CI: '1' },
      });
      const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
      const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      const evidence: StepEvidence = {
        name: step.name,
        command: step.command,
        exitCode: res.status,
        timedOut,
        durationMs: Date.now() - t0,
        outputTail: output.slice(-TAIL_BYTES),
        outputHash: sha256(output),
      };
      steps.push(evidence);
      opts.onStep?.(evidence);
    }
  } finally {
    git(opts.repo, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    id: `ev-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${sha.slice(0, 7)}`,
    sha,
    startedAt,
    finishedAt: new Date().toISOString(),
    mainTreeDirty,
    steps,
    host: { node: process.version, platform: process.platform },
  };
}
