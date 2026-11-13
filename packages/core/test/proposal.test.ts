import { describe, expect, it } from 'vitest';
import { appendOutOfScope } from '../src/index.ts';

describe('向 proposal 的「范围外」一节追加条目', () => {
  const proposal = '# 批量导入\n\n## Why\n运营要导入\n\n## 范围外\n- 不做 UI\n- 不做导出\n\n## 备注\n人写的备注\n';

  it('只在本节末尾追加，其余内容一字不改；人写的条目保留', () => {
    const out = appendOutOfScope(proposal, ['不发送欢迎邮件（Q-4）']);
    expect(out).toBe('# 批量导入\n\n## Why\n运营要导入\n\n## 范围外\n- 不做 UI\n- 不做导出\n- 不发送欢迎邮件（Q-4）\n\n## 备注\n人写的备注\n');
  });

  it('本节在文末、本节为空、没有本节', () => {
    expect(appendOutOfScope('# T\n\n## 范围外\n- 不做 UI\n', ['不发邮件（Q-4）'])).toBe('# T\n\n## 范围外\n- 不做 UI\n- 不发邮件（Q-4）\n');
    expect(appendOutOfScope('# T\n\n## 范围外\n', ['不发邮件（Q-4）'])).toBe('# T\n\n## 范围外\n- 不发邮件（Q-4）\n');
    expect(appendOutOfScope('# T\n\n## Why\nx\n', ['不发邮件（Q-4）'])).toBe('# T\n\n## Why\nx\n\n## 范围外\n- 不发邮件（Q-4）\n');
  });

  it('已有相同条目不重复追加；条目前的 "- " 不会重复', () => {
    const once = appendOutOfScope(proposal, ['- 不发邮件（Q-4）']);
    expect(appendOutOfScope(once, ['不发邮件（Q-4）'])).toBe(once);
    expect(appendOutOfScope(proposal, ['不做 UI'])).toBe(proposal);
  });
});
