import { describe, expect, it } from 'vitest';
import type { Actor } from '@specforge/shared';
import { designBinding, evaluateDesign, nextStage, parseDesign, pathsIn, type DesignInputs } from '../src/index.ts';

const T = '2026-11-12T10:00:00Z';
const dev: Actor = { name: 'yan', role: 'dev' };

const good = `# 方案

## 实现
新增 importUsers：逐行调用 createUser，角色固定为 member（AC-1）；失败行记录行号与原因（AC-2）；入口先 requireAdmin（AC-3）。

## 结构变更
- [S-1] 新增模块 \`src/import.js\`，导出 importUsers(operator, csv)
- [S-2] 新增测试 test/import.test.js
`;

const inputs = (over: Partial<DesignInputs> = {}): DesignInputs => {
  const text = over.text ?? good;
  return {
    design: parseDesign('design.md', text),
    text,
    acIds: ['AC-1', 'AC-2', 'AC-3'],
    specBinding: 'spec-hash',
    approvals: [],
    tier: 'M',
    protectedPaths: ['.github/**', '**/vitest.config.*'],
    ...over,
  };
};

const failed = (i: DesignInputs) => evaluateDesign(i, T).checks.filter((c) => !c.passed).map((c) => c.id);

describe('design.md 解析', () => {
  it('提取 AC 引用、结构变更条目与路径', () => {
    const d = parseDesign('design.md', good);
    expect([...d.acRefs].sort()).toEqual(['AC-1', 'AC-2', 'AC-3']);
    expect(d.changes.map((c) => c.id)).toEqual(['S-1', 'S-2']);
    expect(pathsIn(d.changes[0]!.text)).toEqual(['src/import.js']);
    expect(pathsIn(d.changes[1]!.text)).toEqual(['test/import.test.js']);
  });

  it('「无：原因」与格式错误的条目', () => {
    const d = parseDesign('d', '## 结构变更\n- 无：只改了现有函数的校验逻辑\n\n## 其他\n- 不在本节，不检查\n');
    expect(d).toMatchObject({ hasStructureSection: true, changes: [], noneReason: '只改了现有函数的校验逻辑', malformed: [] });
    expect(parseDesign('d', '## 结构变更\n- 新增了一个模块\n').malformed).toEqual([{ line: 2, text: '新增了一个模块' }]);
  });
});

describe('G3 方案门', () => {
  it('M 档：覆盖全部 AC 且有结构变更清单即通过，无需审批', () => {
    const ev = evaluateDesign(inputs(), T);
    expect(ev.status).toBe('passed');
    expect(ev.checks.some((c) => c.id === 'approved')).toBe(false);
  });

  it('没有 design.md、漏 AC、引用不存在的 AC、缺结构变更都会被拦截', () => {
    expect(evaluateDesign(inputs({ design: undefined, text: '' }), T).status).toBe('failed');
    expect(failed(inputs({ text: good.replace('（AC-3）', '') }))).toEqual(['ac-covered']);
    expect(failed(inputs({ text: good + '\n顺便处理 AC-9\n' }))).toEqual(['ac-known']);
    expect(failed(inputs({ text: good.replace(/## 结构变更[\s\S]*$/, '') }))).toEqual(['structure']);
    expect(failed(inputs({ text: good + '- 无：其实没有\n' }))).toEqual(['structure']);
  });

  it('L 档需要审批；审批绑定内容，方案或 spec 改动后失效', () => {
    const l = inputs({ tier: 'L' });
    expect(failed(l)).toEqual(['approved']);
    const hash = designBinding(l);
    const approved = { ...l, approvals: [{ target: 'design' as const, hash, actor: dev, at: T }] };
    expect(evaluateDesign(approved, T).status).toBe('passed');
    expect(failed({ ...approved, text: good + '\n补充一句' })).toEqual(['approved']);
    expect(failed({ ...approved, specBinding: 'spec-changed' })).toEqual(['approved']);
    // spec 的审批不能当方案审批用
    expect(failed({ ...l, approvals: [{ target: 'spec', hash, actor: dev, at: T }] })).toEqual(['approved']);
  });

  it('M 档的结构变更涉及受保护路径时也需要审批', () => {
    const text = good + '- [S-3] 调整 `vitest.config.ts` 的超时\n';
    const ev = evaluateDesign(inputs({ text }), T);
    const c = ev.checks.find((x) => x.id === 'approved')!;
    expect(c.passed).toBe(false);
    expect(c.label).toContain('S-3 vitest.config.ts');
  });
});

describe('状态机加入 design 阶段', () => {
  const pass = (gate: 'G1' | 'G2' | 'G3') => ({ gate, status: 'passed' as const, checks: [], boundTo: { kind: 'content' as const, value: 'x' }, evaluatedAt: T });
  it('M 档 spec → design → implement；离开 design 需要 G1、G2、G3', () => {
    expect(nextStage('spec', 'M', { G1: pass('G1'), G2: pass('G2') })).toBe('design');
    expect(() => nextStage('design', 'M', { G1: pass('G1'), G2: pass('G2') })).toThrow(/G3/);
    expect(nextStage('design', 'M', { G1: pass('G1'), G2: pass('G2'), G3: pass('G3') })).toBe('implement');
  });
  it('S 档不经过 design', () => {
    expect(nextStage('analysis', 'S', { G1: pass('G1') })).toBe('implement');
  });
});
