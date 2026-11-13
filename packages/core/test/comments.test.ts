import { describe, expect, it } from 'vitest';
import type { Actor, ArtifactComment } from '@specforge/shared';
import { addComment, addressComments, artifactTargetOf, evaluateSpec, locateComment, reopenComment, resolveComment, unresolvedComments } from '../src/index.ts';

const T = '2026-11-13T00:00:00Z';
const dev: Actor = { name: 'alice', role: 'dev' };
const agent: Actor = { name: 'spec-writer@x', role: 'agent' };
const SPEC = 'openspec/changes/c1/specs/a/spec.md';
const text = '## ADDED\n### Requirement: R\n#### Scenario: [AC-1] 导入\n- THEN 成功\n';
const add = (cs: ArtifactComment[] = [], over: Partial<{ path: string; line: number; text: string }> = {}) =>
  addComment(cs, { changeId: 'c1', path: SPEC, line: 4, text: 'THEN 要写具体返回值', ...over }, text, dev, T);

describe('产物评论', () => {
  it('只能评论本 change 的 proposal / spec / design / tasks；行号与内容校验', () => {
    expect(['proposal.md', 'specs/x/spec.md', 'design.md', 'tasks.md', 'notes.md'].map((f) => artifactTargetOf('c1', `openspec/changes/c1/${f}`))).toEqual(['spec', 'spec', 'design', 'tasks', undefined]);
    expect(artifactTargetOf('c1', 'openspec/changes/c2/design.md')).toBeUndefined();
    expect(() => add([], { path: 'src/a.js' })).toThrow(/只能评论/);
    expect(() => add([], { line: 9 })).toThrow(/行号超出范围：1–5/);
    expect(() => add([], { text: '  ' })).toThrow(/不能为空/);
    expect(() => addComment([], { changeId: 'c1', path: SPEC, line: 1, text: 'x' }, undefined, dev, T)).toThrow(/不存在/);
    const [c] = add();
    expect(c).toMatchObject({ id: 'C-1', target: 'spec', line: 4, quote: '- THEN 成功', status: 'open', by: dev });
    expect(add(add()).map((x) => x.id)).toEqual(['C-1', 'C-2']);
  });

  it('文件变化后按原文重新定位：原位、移动（取最近）、已不在', () => {
    const c = { line: 2, quote: 'b' };
    expect(locateComment(c, 'a\nb\nc')).toEqual({ state: 'exact', line: 2 });
    expect(locateComment(c, 'x\na\nz\nb\nb')).toEqual({ state: 'moved', line: 4 });
    expect(locateComment(c, 'a\nB\nc')).toEqual({ state: 'outdated' });
    expect(locateComment(c, undefined)).toEqual({ state: 'outdated' });
    expect(locateComment({ line: 1, quote: '' }, 'x\n\ny')).toEqual({ state: 'outdated' });
  });

  it('原文不唯一时用上下文消歧：同文的另一行不会被误认为原评论行（DeepSeek 实测回归）', () => {
    const before = ['#### Scenario: [AC-5] 缺列', '- **WHEN** 缺少 email 列', '- **THEN** 系统抛出错误', '', '#### Scenario: [AC-6] 无数据', '- **WHEN** 只有表头', '- **THEN** 系统抛出错误', ''].join('\n');
    const [c] = addComment([], { changeId: 'c1', path: SPEC, line: 3, text: '写具体错误信息' }, before, dev, T);
    expect(c!.context).toEqual({ before: '- **WHEN** 缺少 email 列', after: '' });
    // AC-5 的那一行被改掉，AC-6 的同文行仍在：应当是 outdated，而不是移动到 AC-6
    const after = before.replace('- **THEN** 系统抛出错误\n\n#### Scenario: [AC-6]', '- **THEN** 抛出“表头必须包含 email”\n\n#### Scenario: [AC-6]');
    expect(locateComment(c!, after)).toEqual({ state: 'outdated' });
    // 上方插入一行：原文连同上下文一起移动
    expect(locateComment(c!, `# 新标题\n${before}`)).toEqual({ state: 'moved', line: 4 });
    // 旧评论没有上下文：保持原来的行为
    expect(locateComment({ line: 3, quote: '- **THEN** 系统抛出错误' }, after)).toEqual({ state: 'moved', line: 7 });
  });

  it('agent 必须逐条回应全部待处理评论；回应只标为"已回应"，由人确认解决', () => {
    const cs = add(add(), { line: 3, text: '场景名太笼统' });
    expect(() => addressComments(cs, 'spec', [{ commentId: 'C-1', response: 'fixed', note: '已改' }], agent, T)).toThrow(/还有评论没有回应：C-2/);
    expect(() => addressComments(cs, 'spec', [{ commentId: 'C-9', response: 'fixed', note: '已改' }], agent, T)).toThrow(/不存在或不是待处理/);
    const done = addressComments(
      cs,
      'spec',
      [
        { commentId: 'C-1', response: 'fixed', note: '改为返回 { success: 2 }' },
        { commentId: 'C-2', response: 'declined', note: '场景名与 Q-1 的答案一致' },
      ],
      agent,
      T,
    );
    expect(done.map((c) => c.status)).toEqual(['addressed', 'addressed']);
    expect(done[1]!.history).toEqual([{ kind: 'addressed', by: agent, at: T, note: '场景名与 Q-1 的答案一致', response: 'declined' }]);
    expect(unresolvedComments(done, 'spec')).toHaveLength(2);
    expect(() => resolveComment(done, 'C-1', agent, T)).toThrow(/只能由人确认/);
    const resolved = resolveComment(done, 'C-1', dev, T, '确认');
    expect(unresolvedComments(resolved, 'spec').map((c) => c.id)).toEqual(['C-2']);
    expect(() => resolveComment(resolved, 'C-1', dev, T)).toThrow(/已解决/);
    expect(() => reopenComment(resolved, 'C-1', dev, T, '')).toThrow(/必须写原因/);
    expect(reopenComment(resolved, 'C-1', dev, T, '还是不对').find((c) => c.id === 'C-1')!.status).toBe('open');
    expect(unresolvedComments(resolved, 'design')).toEqual([]);
  });

  it('G2：未解决的评论挡住门禁；评论不参与绑定哈希', () => {
    const base = { specs: [], sources: [{ path: SPEC, text }], questions: [], understandingBinding: 'u', approvals: [], tier: 'M' as const };
    const a = evaluateSpec({ ...base, unresolvedComments: ['C-1'] }, T);
    const b = evaluateSpec({ ...base, unresolvedComments: [] }, T);
    expect(a.checks.find((c) => c.id === 'comments')).toMatchObject({ passed: false, detail: '未解决：C-1' });
    expect(b.checks.find((c) => c.id === 'comments')!.passed).toBe(true);
    expect(a.boundTo.value).toBe(b.boundTo.value);
    expect(evaluateSpec(base, T).checks.some((c) => c.id === 'comments')).toBe(false);
  });
});
