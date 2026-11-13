import { useState } from 'react';
import { api } from '../api.ts';
import { useData } from '../live.ts';
import { eventCategory, eventSummary, formatTime, href } from '../model.ts';
import { Loading, Raw } from './common.tsx';

const CATEGORIES = { all: '全部', stage: '流程', question: '需求与问题', agent: 'agent', evidence: '证据', review: '审查与审批', other: '其他' } as const;
type Category = keyof typeof CATEGORIES;

/** 事件时间线（最新在前）；不传 changeId 时显示全部 change 的事件 */
export function Timeline({ changeId, version }: { changeId?: string; version: number }) {
  const { data, error } = useData(() => api.events(changeId), [changeId, version]);
  const [filter, setFilter] = useState<Category>('all');
  if (!data) return <Loading error={error} />;
  const shown = data.filter((e) => filter === 'all' || eventCategory(e.type) === filter).reverse();

  return (
    <>
      {!changeId && <h1>全部事件</h1>}
      <div className="filters">
        {(Object.keys(CATEGORIES) as Category[]).map((k) => (
          <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
            {CATEGORIES[k]}
          </button>
        ))}
        <span className="muted">
          {shown.length} / {data.length} 条
        </span>
      </div>
      <ol className="timeline">
        {shown.map((e) => (
          <li key={e.seq} className={`ev-${eventCategory(e.type)}`}>
            <div className="ev-head">
              <span className="seq">#{e.seq}</span>
              <span className="time">{formatTime(e.at)}</span>
              {!changeId && e.changeId && (
                <a href={href({ page: 'change', id: e.changeId, tab: 'timeline' })}>
                  <code>{e.changeId}</code>
                </a>
              )}
              <span className={`actor ${e.actor.role}`}>
                {e.actor.name}（{e.actor.role}）
              </span>
              <code className="type">{e.type}</code>
            </div>
            <div className="ev-summary">{eventSummary(e)}</div>
            <Raw value={e.payload} label="载荷" />
          </li>
        ))}
      </ol>
    </>
  );
}
