import { describe, expect, it } from 'vitest';
import type { ForgeEvent } from '@specforge/shared';
import { chainEvent, checkPathPolicy, findAddedSkips, globToRegExp, verifyChain } from '../src/index.ts';

const actor = { name: 'yan', role: 'dev' as const };

function chain(n: number): ForgeEvent[] {
  const out: ForgeEvent[] = [];
  for (let i = 0; i < n; i++) out.push(chainEvent(out.at(-1), { type: 't', actor, payload: { i } }, `2026-11-12T10:0${i}:00Z`));
  return out;
}

describe('哈希链事件日志', () => {
  it('完整的链校验通过', () => {
    expect(verifyChain(chain(3))).toEqual([]);
  });

  it('篡改内容、删除事件都能被发现', () => {
    const tampered = chain(3);
    tampered[1] = { ...tampered[1]!, payload: { i: 99 } };
    expect(verifyChain(tampered).map((p) => p.seq)).toEqual([2]);

    const removed = chain(3);
    removed.splice(1, 1);
    expect(verifyChain(removed).length).toBeGreaterThan(0);
  });
});

describe('路径策略与防作弊', () => {
  it('glob 匹配', () => {
    expect(globToRegExp('**/*.test.*').test('src/a/b.test.ts')).toBe(true);
    expect(globToRegExp('**/*.test.*').test('b.test.ts')).toBe(true);
    expect(globToRegExp('.github/**').test('.github/workflows/ci.yml')).toBe(true);
    expect(globToRegExp('src/*').test('src/a/b.ts')).toBe(false);
  });

  it('事后校验：越界和命中禁止路径', () => {
    const v = checkPathPolicy(['src/a.ts', 'openspec/changes/x/specs/s/spec.md', 'README.md'], {
      writable: ['src/**', 'openspec/**'],
      forbidden: ['openspec/changes/*/specs/**'],
    });
    expect(v).toEqual([
      { path: 'openspec/changes/x/specs/s/spec.md', reason: '命中禁止路径' },
      { path: 'README.md', reason: '不在本阶段可写范围内' },
    ]);
  });

  it('只扫描测试文件中新增的 skip 标记', () => {
    const diff = [
      '+++ b/src/a.test.ts',
      '+  it.skip("x", () => {})',
      '-  it.skip("old", () => {})',
      '+++ b/src/skip.ts',
      '+  it.skip("not a test file")',
    ].join('\n');
    const hits = findAddedSkips(diff, ['\\b(it|test|describe)\\.skip\\('], ['**/*.test.*']);
    expect(hits).toEqual([{ file: 'src/a.test.ts', line: 'it.skip("x", () => {})', pattern: '\\b(it|test|describe)\\.skip\\(' }]);
  });
});
