import { describe, expect, it } from 'vitest';
import type { GateEvaluation, GateId, StepEvidence, TddEvidence } from '@specforge/shared';
import { evaluateTdd, nextStage, parseTasks, tddAttemptChecks, type TddInputs } from '../src/index.ts';

const T = '2026-11-13T00:00:00Z';
const step = (exitCode: number | null, timedOut = false): StepEvidence => ({
  name: 'test',
  command: 'node --test',
  exitCode,
  timedOut,
  durationMs: 1,
  outputTail: '',
  outputHash: 'h',
});
const ev = (taskId: string, red: StepEvidence | undefined, green: StepEvidence | undefined, extra: Partial<TddEvidence> = {}): TddEvidence => ({
  id: `tdd-${taskId}`,
  taskId,
  base: 'b',
  sha: `s-${taskId}`,
  testFiles: ['test/x.test.js'],
  red: { test: red },
  green: { test: green },
  startedAt: T,
  finishedAt: T,
  host: { node: 'v22', platform: 'darwin' },
  ...extra,
});
const failedIds = (e: TddEvidence) => tddAttemptChecks(e).filter((c) => !c.passed).map((c) => c.id);

const tasks = parseTasks('tasks.md', '- [x] T-1 a（AC-1）\n- [x] T-2 b（AC-2）依赖 T-1\n');
const inputs = (records: TddInputs['records'], over: Partial<TddInputs> = {}): TddInputs => ({ configured: true, tasks, records, ...over });

describe('G5 TDD 门', () => {
  it('单次尝试：先红后绿才通过', () => {
    expect(failedIds(ev('T-1', step(1), step(0)))).toEqual([]);
    expect(failedIds(ev('T-1', step(0), step(0)))).toEqual(['red']);
    expect(failedIds(ev('T-1', step(null, true), step(0)))).toEqual(['red']);
    expect(failedIds(ev('T-1', step(1), step(1)))).toEqual(['green']);
    expect(failedIds(ev('T-1', undefined, undefined, { testFiles: [] }))).toEqual(['tests-changed', 'red', 'green']);
    expect(failedIds({ ...ev('T-1', undefined, step(0)), red: { setup: step(2) } })).toEqual(['red']);
    expect(tddAttemptChecks(ev('T-1', step(0), step(0)))[1]!.detail).toMatch(/实现前就通过/);
  });

  it('每个任务都有可达的通过证据才通过；失败后重试成功也算', () => {
    const ok = [
      { evidence: ev('T-1', step(0), step(0)), reachable: true },
      { evidence: ev('T-1', step(1), step(0)), reachable: true },
      { evidence: ev('T-2', step(1), step(0)), reachable: true },
    ];
    expect(evaluateTdd(inputs(ok), T).status).toBe('passed');

    const missing = evaluateTdd(inputs(ok.slice(0, 2)), T);
    expect(missing.status).toBe('failed');
    expect(missing.checks.find((c) => c.id === 'red-green')!.detail).toBe('T-2 没有 TDD 证据');

    const gone = evaluateTdd(inputs([ok[1]!, { ...ok[2]!, reachable: false }]), T);
    expect(gone.checks.find((c) => c.id === 'red-green')!.detail).toMatch(/T-2 的 TDD 证据所在 commit 已不在当前历史中/);

    const greenOnly = evaluateTdd(inputs([ok[0]!, ok[2]!]), T);
    expect(greenOnly.checks.find((c) => c.id === 'red-green')!.detail).toMatch(/T-1：.*实现前就通过/);
  });

  it('未配置命令、任务未勾选、没有任务：都不通过（默认未验证）', () => {
    const ok = [
      { evidence: ev('T-1', step(1), step(0)), reachable: true },
      { evidence: ev('T-2', step(1), step(0)), reachable: true },
    ];
    expect(evaluateTdd(inputs(ok, { configured: false }), T).status).toBe('failed');
    const unchecked = parseTasks('tasks.md', '- [x] T-1 a（AC-1）\n- [ ] T-2 b（AC-2）\n');
    expect(evaluateTdd(inputs(ok, { tasks: unchecked }), T).checks.find((c) => c.id === 'tasks-done')!.detail).toBe('T-2 未完成');
    expect(evaluateTdd(inputs([], { tasks: undefined }), T).status).toBe('failed');
  });

  it('绑定每个任务被采信的证据：换了证据，绑定随之变化', () => {
    const a = evaluateTdd(inputs([{ evidence: ev('T-1', step(1), step(0)), reachable: true }]), T);
    const b = evaluateTdd(inputs([{ evidence: ev('T-1', step(1), step(0), { id: 'tdd-other' }), reachable: true }]), T);
    expect(a.boundTo.value).not.toBe(b.boundTo.value);
  });

  it('M 档离开实现阶段需要 G5；S 档没有任务，不需要', () => {
    const pass = (gate: GateId): GateEvaluation => ({ gate, status: 'passed', checks: [], boundTo: { kind: 'content', value: 'x' }, evaluatedAt: T });
    const up = { G1: pass('G1'), G2: pass('G2'), G3: pass('G3'), G4: pass('G4') };
    expect(() => nextStage('implement', 'M', up)).toThrow(/G5/);
    expect(nextStage('implement', 'M', { ...up, G5: pass('G5') })).toBe('closing');
    expect(nextStage('implement', 'S', { G1: pass('G1') })).toBe('closing');
  });
});
