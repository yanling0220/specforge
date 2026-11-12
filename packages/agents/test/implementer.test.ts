import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { implementPolicy, markTaskDone, nextTask, parseTasks } from '@specforge/core';
import { emptyImplementDraft, implementerTools, makeCanUseTool, writableWorkspaceTools, writeDenial, type ImplementerContext } from '../src/index.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const policy = implementPolicy(['**/vitest.config.*']);

describe('实现阶段的路径约束', () => {
  it('writeDenial：工作目录外、spec、平台状态、受保护路径都被拒绝', () => {
    expect(writeDenial('/w', 'src/a.ts', policy)).toBeUndefined();
    expect(writeDenial('/w', '/w/src/a.ts', policy)).toBeUndefined();
    expect(writeDenial('/w', '../etc/x', policy)).toMatch(/工作目录之外/);
    expect(writeDenial('/w', '/etc/passwd', policy)).toMatch(/工作目录之外/);
    expect(writeDenial('/w', 'openspec/changes/c/spec.md', policy)).toMatch(/禁止路径/);
    expect(writeDenial('/w', '.specforge/events.jsonl', policy)).toMatch(/禁止路径/);
    expect(writeDenial('/w', 'vitest.config.ts', policy)).toMatch(/禁止路径/);
  });

  it('Claude 可写模式：写文件逐次检查路径，Bash 放行，其他工具拒绝', async () => {
    const denied: string[] = [];
    const can = makeCanUseTool({ readOnly: false, cwd: '/w', pathPolicy: policy, toolNamespace: 'specforge', tools: [] }, (n, r) => denied.push(`${n}:${r}`));
    const sig = { signal: new AbortController().signal, toolUseID: 't' } as never;
    expect((await can('Write', { file_path: '/w/src/a.ts' }, sig))?.behavior).toBe('allow');
    expect((await can('Edit', { file_path: '/w/openspec/x.md' }, sig))?.behavior).toBe('deny');
    expect((await can('Write', { file_path: '/tmp/x' }, sig))?.behavior).toBe('deny');
    expect((await can('Bash', { command: 'npm test' }, sig))?.behavior).toBe('allow');
    expect((await can('WebFetch', {}, sig))?.behavior).toBe('deny');
    expect(denied).toHaveLength(3);
  });

  it('openai-compatible 可写工具：写入、替换、运行命令；越界被拒绝', () => {
    const root = mkdtempSync(join(tmpdir(), 'sf-w-'));
    dirs.push(root);
    const [write, replace, run] = writableWorkspaceTools(root, policy);
    write!.handler({ path: 'src/a.js', content: 'const a = 1;\n' });
    replace!.handler({ path: 'src/a.js', old: '1', new: '2' });
    expect(readFileSync(join(root, 'src/a.js'), 'utf8')).toBe('const a = 2;\n');
    expect(() => replace!.handler({ path: 'src/a.js', old: 'zzz', new: 'y' })).toThrow(/出现了 0 次/);
    expect(() => write!.handler({ path: 'openspec/x.md', content: 'x' })).toThrow(/不允许写入/);
    expect(() => write!.handler({ path: '../escape.txt', content: 'x' })).toThrow(/工作目录之外/);
    writeFileSync(join(root, 'ok.sh'), 'echo hi; exit 3');
    expect(run!.handler({ command: 'sh ok.sh' })).toBe('退出码 3\nhi\n');
  });
});

describe('实现 agent 的平台工具', () => {
  const ctx = { task: { id: 'T-1', title: 'x', acRefs: ['AC-1', 'AC-2'], structureRefs: [] } } as unknown as ImplementerContext;
  it('finish_task 要求测试名称覆盖任务的全部 AC；只能提交一次', () => {
    const draft = emptyImplementDraft();
    const [finish, blocked] = implementerTools(draft, ctx);
    expect(() => finish!.handler({ summary: '完成了', testsAdded: ['[AC-1] a'] })).toThrow(/AC-2/);
    finish!.handler({ summary: '完成了', testsAdded: ['[AC-1] a', '[AC-2] b'] });
    expect(draft.finished).toBe(true);
    expect(() => blocked!.handler({ reason: '后悔了' })).toThrow(/已经提交过/);
  });
});

describe('任务清单辅助函数', () => {
  const text = '- [ ] T-1 a（AC-1）\n- [ ] T-2 b（AC-1）依赖 T-1\n- [ ] T-3 c（AC-1）\n';
  it('nextTask 按依赖与顺序选择；markTaskDone 只勾选指定任务', () => {
    expect(nextTask(parseTasks('t', text))?.id).toBe('T-1');
    const after = markTaskDone(text, 'T-1');
    expect(after).toBe('- [x] T-1 a（AC-1）\n- [ ] T-2 b（AC-1）依赖 T-1\n- [ ] T-3 c（AC-1）\n');
    expect(nextTask(parseTasks('t', after))?.id).toBe('T-2');
    expect(markTaskDone(after, 'T-1')).toBe(after);
    expect(() => markTaskDone(text, 'T-9')).toThrow(/找不到/);
    expect(nextTask(parseTasks('t', text.replaceAll('[ ]', '[x]')))).toBeUndefined();
  });
});
