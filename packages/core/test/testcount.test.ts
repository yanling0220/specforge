import { describe, expect, it } from 'vitest';
import type { VerificationEvidence } from '@specforge/shared';
import { evaluateVerification, parseTestCount, type TestCountInputs, type VerificationInputs } from '../src/index.ts';

describe('解析测试数量', () => {
  it.each([
    ['node（TAP）', '1..4\n# tests 4\n# suites 0\n# pass 3\n# fail 1\n', 4, 'node'],
    ['node（spec）', 'ℹ tests 7\nℹ suites 1\nℹ pass 7\n', 7, 'node'],
    ['vitest（含颜色）', '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m2 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m111 passed\u001b[39m\u001b[22m\u001b[90m (113)\u001b[39m\n', 113, 'vitest'],
    ['jest', 'Test Suites: 1 failed, 2 passed, 3 total\nTests:       1 failed, 3 passed, 4 total\n', 4, 'jest'],
    ['pytest', '....s.F\n========== 1 failed, 5 passed, 1 skipped in 0.12s ==========\n', 7, 'pytest'],
    ['mocha', '\n  5 passing (12ms)\n  2 pending\n  1 failing\n', 8, 'mocha'],
    ['cargo（多个测试二进制）', 'test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured\n\ntest result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured\n', 7, 'cargo'],
  ])('%s', (_, out, total, format) => {
    expect(parseTestCount(out)).toEqual({ total, format });
  });

  it('自定义 pattern 优先；无法识别返回 undefined', () => {
    expect(parseTestCount('Ran 12 tests in 0.3s\n', 'Ran (\\d+) tests')).toEqual({ total: 12, format: 'pattern' });
    expect(parseTestCount('# tests 4\n', 'Ran (\\d+) tests')).toBeUndefined();
    expect(parseTestCount('ok  \tgithub.com/x/y\t0.01s\n')).toBeUndefined();
  });

  it('同一输出出现多次汇总时取最后一次', () => {
    expect(parseTestCount('# tests 2\n...\n# tests 5\n')!.total).toBe(5);
  });
});

describe('G6A：测试数量不得下降', () => {
  const ev: VerificationEvidence = {
    id: 'ev',
    sha: 'head',
    startedAt: 'T',
    finishedAt: 'T',
    mainTreeDirty: false,
    steps: [{ name: 'test', command: 'x', exitCode: 0, timedOut: false, durationMs: 1, outputTail: '', outputHash: 'h' }],
    host: { node: 'v22', platform: 'darwin' },
  };
  const inputs = (testCount: Partial<TestCountInputs>, over: Partial<VerificationInputs> = {}): VerificationInputs => ({
    headSha: 'head',
    requiredSteps: ['test'],
    evidence: ev,
    acIds: [],
    requireAc: false,
    acCoverage: {},
    skipHits: [],
    protectedChanges: [],
    testCount: { step: 'test', head: 5, baseEvidence: true, base: 5, baseHasTests: true, ...testCount },
    ...over,
  });
  const result = (t: Partial<TestCountInputs>, over?: Partial<VerificationInputs>) =>
    evaluateVerification(inputs(t, over), 'T').checks.find((c) => c.id === 'test-count')!;

  it('持平或增加通过，并写明基线与当前数量', () => {
    expect(result({})).toMatchObject({ passed: true, detail: '基线 5 → 当前 5' });
    expect(result({ head: 6 }).passed).toBe(true);
  });

  it('下降、无法解析、缺基线证据、无证据：都不通过', () => {
    expect(result({ head: 4 })).toMatchObject({ passed: false, detail: '测试数量从 5 降到 4' });
    expect(result({ head: undefined }).detail).toMatch(/无法从 test 步骤的输出解析测试数量/);
    expect(result({ baseEvidence: false, base: undefined }).detail).toMatch(/没有基线 commit 的验证证据/);
    expect(result({ base: undefined }).detail).toMatch(/无法从基线 commit/);
    expect(result({}, { evidence: undefined }).detail).toBe('无证据');
  });

  it('基线没有测试文件时视为 0', () => {
    expect(result({ base: undefined, baseHasTests: false, head: 1 })).toMatchObject({ passed: true, detail: '基线 0 → 当前 1' });
  });

  it('不提供 testCount 时不加这一项', () => {
    expect(evaluateVerification(inputs({}, { testCount: undefined }), 'T').checks.some((c) => c.id === 'test-count')).toBe(false);
  });
});
