import { expect, it } from 'vitest';
import type { InboxItem } from '@specforge/shared';
import { inboxHref, parseRoute } from '../src/model.ts';
import { projectHref } from '../src/project.ts';

it('收件箱入口保留项目和部署前缀，问题定位 Q，审批和签字进入现有操作页', () => {
  const base = { id: 'item', changeId: 'same', changeTitle: '示例', stage: 'closing' as const, role: 'dev' as const };
  const items: InboxItem[] = [
    { ...base, kind: 'question-confirmation', role: 'product', questionId: 'Q-1', rev: 2, answerHash: 'hash' },
    { ...base, kind: 'spec-approval', contentHash: 'hash' },
    { ...base, kind: 'design-approval', contentHash: 'hash' },
    { ...base, kind: 'human-signoff', sha: 'sha' },
  ];
  for (const item of items) {
    const hash = inboxHref(item);
    expect(parseRoute(hash)).toEqual(item.kind === 'question-confirmation'
      ? { page: 'change', id: 'same', tab: 'analysis', qid: 'Q-1' }
      : { page: 'change', id: 'same', tab: 'gates' });
    expect(projectHref('alpha', hash, '/console/team')).toBe(`/console/team/p/alpha/${hash}`);
    expect(hash).not.toMatch(/token|answerHash|rev=/);
  }
});
