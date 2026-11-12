import { describe, expect, it } from 'vitest';
import { evaluateTasks, executionOrder, findCycles, nextStage, parseTasks, tasksBinding, type TasksInputs } from '../src/index.ts';

const T = '2026-11-12T10:00:00Z';

const good = `## 1. 导入
- [ ] T-1 实现 importUsers（AC-1, AC-2, S-1）
- [ ] T-2 入口加管理员校验（AC-3）依赖 T-1
- [ ] T-3 补充测试（AC-1, AC-2, AC-3, S-2）依赖：T-1、T-2
`;

const inputs = (text = good, over: Partial<TasksInputs> = {}): TasksInputs => ({
  tasks: parseTasks('tasks.md', text),
  acIds: ['AC-1', 'AC-2', 'AC-3'],
  structureIds: ['S-1', 'S-2'],
  designBinding: 'design-hash',
  ...over,
});
const failed = (i: TasksInputs) => evaluateTasks(i, T).checks.filter((c) => !c.passed).map((c) => c.id);

describe('tasks.md 解析', () => {
  it('编号、引用、依赖、勾选状态', () => {
    const p = parseTasks('tasks.md', good.replace('- [ ] T-2', '- [x] T-2'));
    expect(p.tasks.map((t) => [t.id, t.done, t.acRefs, t.structureRefs, t.dependsOn])).toEqual([
      ['T-1', false, ['AC-1', 'AC-2'], ['S-1'], []],
      ['T-2', true, ['AC-3'], [], ['T-1']],
      ['T-3', false, ['AC-1', 'AC-2', 'AC-3'], ['S-2'], ['T-1', 'T-2']],
    ]);
    expect(p.tasks[1]!.title).toBe('入口加管理员校验（AC-3）');
  });

  it('依赖里出现的 T-n 不算作 AC/S 引用；没有编号的条目被标记', () => {
    const p = parseTasks('t', '- [ ] T-1 做事（AC-1）depends on T-2\n- [ ] 忘了编号\n');
    expect(p.tasks[0]!.dependsOn).toEqual(['T-2']);
    expect(p.malformed).toEqual([{ line: 2, text: '忘了编号' }]);
  });

  it('执行顺序与依赖环', () => {
    const tasks = parseTasks('t', good).tasks;
    expect(executionOrder(tasks)).toEqual(['T-1', 'T-2', 'T-3']);
    expect(findCycles([{ id: 'T-1', dependsOn: ['T-2'] }, { id: 'T-2', dependsOn: ['T-1'] }])).toEqual([['T-1', 'T-2', 'T-1']]);
    expect(() => executionOrder([{ id: 'T-1', dependsOn: ['T-2'] }, { id: 'T-2', dependsOn: ['T-1'] }])).toThrow(/环/);
  });
});

describe('G4 任务门', () => {
  it('合格的任务清单通过', () => {
    expect(evaluateTasks(inputs(), T).status).toBe('passed');
  });

  it('没有任务文件或任务为空时不通过', () => {
    expect(evaluateTasks(inputs(good, { tasks: undefined }), T).status).toBe('failed');
    expect(failed(inputs('# 只有标题\n'))).toEqual(['exists']);
  });

  it('任务没关联 AC、引用不存在、AC 或结构变更没人负责', () => {
    expect(failed(inputs(good.replace('（AC-3）依赖', '依赖')))).toEqual(['task-ac']);
    expect(failed(inputs(good + '- [ ] T-4 额外（AC-9, S-7）\n'))).toEqual(['refs-known']);
    expect(failed(inputs(good, { acIds: ['AC-1', 'AC-2', 'AC-3', 'AC-4'] }))).toEqual(['ac-covered']);
    expect(failed(inputs(good, { structureIds: ['S-1', 'S-2', 'S-3'] }))).toEqual(['structure-covered']);
  });

  it('编号重复、缺编号、依赖不存在、依赖自己、依赖成环', () => {
    expect(failed(inputs(good + '- [ ] T-1 又一个（AC-1）\n'))).toEqual(['format']);
    expect(failed(inputs(good + '- [ ] 漏了编号（AC-1）\n'))).toEqual(['format']);
    const deps = (extra: string) => evaluateTasks(inputs(good + extra), T).checks.find((c) => c.id === 'deps')!.detail;
    expect(deps('- [ ] T-4 x（AC-1）依赖 T-9\n')).toBe('T-4 依赖不存在的 T-9');
    expect(deps('- [ ] T-4 x（AC-1）依赖 T-4\n')).toBe('T-4 依赖自己');
    const cyclic = good.replace('- [ ] T-1 实现 importUsers（AC-1, AC-2, S-1）', '- [ ] T-1 实现 importUsers（AC-1, AC-2, S-1）依赖 T-3');
    expect(evaluateTasks(inputs(cyclic), T).checks.find((c) => c.id === 'deps')!.detail).toMatch(/依赖环：T-1 → T-3 → T-1|依赖环：T-1 → T-2 → T-3 → T-1/);
  });

  it('勾选进度不改变绑定；改任务内容或上游方案会改变绑定', () => {
    const base = tasksBinding(inputs());
    expect(tasksBinding(inputs(good.replaceAll('- [ ]', '- [x]')))).toBe(base);
    expect(tasksBinding(inputs(good.replace('补充测试', '补充单元测试')))).not.toBe(base);
    expect(tasksBinding(inputs(good, { designBinding: 'changed' }))).not.toBe(base);
  });
});

describe('状态机加入 tasks 阶段', () => {
  const pass = (gate: 'G1' | 'G2' | 'G3' | 'G4') => ({ gate, status: 'passed' as const, checks: [], boundTo: { kind: 'content' as const, value: 'x' }, evaluatedAt: T });
  it('design → tasks → implement；离开 tasks 需要 G4', () => {
    const up = { G1: pass('G1'), G2: pass('G2'), G3: pass('G3') };
    expect(nextStage('design', 'M', up)).toBe('tasks');
    expect(() => nextStage('tasks', 'M', up)).toThrow(/G4/);
    expect(nextStage('tasks', 'M', { ...up, G4: pass('G4') })).toBe('implement');
  });
});
