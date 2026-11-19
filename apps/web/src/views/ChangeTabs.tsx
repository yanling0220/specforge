import { href, type Route } from '../model.ts';

export type ChangeTab = Extract<Route, { page: 'change' }>['tab'];

const tabs = [
  ['gates', '门禁'],
  ['analysis', '需求分析'],
  ['artifacts', '产物审阅'],
  ['review', '代码审查'],
  ['timeline', '事件时间线'],
] as const;

export function ChangeTabs({ id, tab, openBlocking = 0, openComments = 0 }: {
  id: string; tab: ChangeTab; openBlocking?: number; openComments?: number;
}) {
  return (
    <nav className="tabs" aria-label="变更详情">
      {tabs.map(([key, label]) => {
        const count = key === 'analysis' ? openBlocking : key === 'artifacts' ? openComments : 0;
        return <a key={key} className={tab === key ? 'active' : ''} aria-current={tab === key ? 'page' : undefined}
          href={href({ page: 'change', id, tab: key })}>
          {label}{count > 0 && <span className="badge bad">{count}</span>}
        </a>;
      })}
    </nav>
  );
}
