import { describe, expect, it } from 'vitest';
import type { Change, ProjectConfig, ReviewRecord } from '@specforge/shared';
import { applyReviewOutcome, maxFixRounds, openFixRound, resolveFixRound } from '../src/index.ts';

const T = '2026-11-13T00:00:00Z';
const change = (over: Partial<Change> = {}): Change => ({
  id: 'c1',
  title: 't',
  tier: 'M',
  stage: 'closing',
  baseSha: 'base',
  createdAt: T,
  createdBy: { name: 'b', role: 'dev' },
  ...over,
});
const review = (verdict: 'pass' | 'fail', sha = 'sha1', kind: 'agent' | 'human' = 'agent'): ReviewRecord => ({
  kind,
  sha,
  verdict,
  reviewer: { name: 'r', role: kind === 'agent' ? 'agent' : 'dev' },
  at: T,
  coverage: ['AC-1'],
  findings: [
    { severity: 'blocking', kind: 'missing', anchor: 'AC-1', text: '没有校验行号' },
    { severity: 'non-blocking', text: '命名可以更好' },
  ],
});

describe('打回与修复轮次', () => {
  it('收尾阶段审查不通过：回到实现阶段，开启第 1 轮修复，只带阻塞问题', () => {
    const { change: c, outcome } = applyReviewOutcome(change(), review('fail'), 3, T);
    expect(outcome).toEqual({ kind: 'sent-back', round: 1 });
    expect(c.stage).toBe('implement');
    expect(c.fixRounds).toEqual([
      { round: 1, sha: 'sha1', source: 'agent', reviewer: { name: 'r', role: 'agent' }, findings: [review('fail').findings[0]], note: undefined, at: T },
    ]);
    expect(openFixRound(c)!.round).toBe(1);
  });

  it('通过、不在收尾阶段：不处理；开发者签字不通过同样打回', () => {
    expect(applyReviewOutcome(change(), review('pass'), 3, T).outcome.kind).toBe('none');
    expect(applyReviewOutcome(change({ stage: 'implement' }), review('fail'), 3, T).outcome.kind).toBe('none');
    expect(applyReviewOutcome(change(), review('fail', 'sha1', 'human'), 3, T).change.fixRounds![0]!.source).toBe('human');
  });

  it('修复后离开实现阶段：必须有新提交，结清本轮', () => {
    const sent = applyReviewOutcome(change(), review('fail'), 3, T).change;
    expect(() => resolveFixRound(sent, 'sha1')).toThrow(/第 1 轮修复还没有新的提交/);
    const resolved = resolveFixRound(sent, 'sha2');
    expect(resolved.fixRounds![0]!.resolvedSha).toBe('sha2');
    expect(openFixRound(resolved)).toBeUndefined();
    expect(resolveFixRound(resolved, 'sha2')).toBe(resolved);
  });

  it('轮次用尽后升级给人：停在收尾阶段，之后不再自动打回', () => {
    let c = change();
    for (let i = 1; i <= 2; i++) {
      c = applyReviewOutcome(c, review('fail', `sha${i}`), 2, T).change;
      c = { ...resolveFixRound(c, `fix${i}`), stage: 'closing' };
    }
    const { change: escalated, outcome } = applyReviewOutcome(c, review('fail', 'sha3'), 2, T);
    expect(outcome).toEqual({ kind: 'escalated', rounds: 2 });
    expect(escalated.stage).toBe('closing');
    expect(escalated.escalation).toMatchObject({ rounds: 2, reason: expect.stringMatching(/最大修复轮次（2）/) });
    expect(applyReviewOutcome(escalated, review('fail', 'sha4'), 2, T).outcome.kind).toBe('none');
    // 上限为 0：第一次不通过就升级
    expect(applyReviewOutcome(change(), review('fail'), 0, T).outcome.kind).toBe('escalated');
  });

  it('workflow.maxFixRounds 默认 3，必须是非负整数', () => {
    const cfg = (workflow?: ProjectConfig['workflow']) => ({ workflow }) as ProjectConfig;
    expect(maxFixRounds(cfg())).toBe(3);
    expect(maxFixRounds(cfg({ maxFixRounds: 0 }))).toBe(0);
    expect(() => maxFixRounds(cfg({ maxFixRounds: -1 }))).toThrow(/非负整数/);
    expect(() => maxFixRounds(cfg({ maxFixRounds: 1.5 }))).toThrow(/非负整数/);
  });
});
