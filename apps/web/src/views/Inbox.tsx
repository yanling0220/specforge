import { useEffect, useState } from 'react';
import type { HumanRole, InboxItem } from '@specforge/shared';
import { api } from '../api.ts';
import { useData } from '../live.ts';
import { INBOX_LABEL, inboxHref, STAGE_LABEL } from '../model.ts';
import { Loading } from './common.tsx';

export function Inbox({ role, version }: { role: HumanRole; version: number }) {
  const [refresh, setRefresh] = useState(0);
  const [kind, setKind] = useState<InboxItem['kind'] | ''>('');
  // HEAD 或产物也可能在没有业务事件的情况下变化，定时重新核对当前事实。
  useEffect(() => {
    const timer = setInterval(() => setRefresh((value) => value + 1), 15_000);
    return () => clearInterval(timer);
  }, []);
  const result = useData(() => api.inbox(role), [role, version, refresh]);
  const items = result.data?.role === role ? result.data.items : undefined;
  const visible = items?.filter((item) => !kind || item.kind === kind);
  return (
    <>
      <h1>审批收件箱 <small className="muted">当前项目 · {role} 角色{items ? ` · ${items.length} 项` : ''}</small></h1>
      <p className="muted">同角色任一成员处理即可完成。请进入详情核对当前版本后操作。</p>
      <div className="inbox-toolbar">
        <label>事项类型{' '}
          <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="">全部</option>
            {Object.entries(INBOX_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <button onClick={() => setRefresh((value) => value + 1)} disabled={result.loading}>刷新</button>
        {result.loading && items && <span className="muted" role="status">正在核对…</span>}
      </div>
      {!items ? <Loading error={result.error} /> : !visible?.length ? (
        <div className="panel muted" role="status">{items.length ? '当前类型没有待处理事项。' : '当前角色暂无待审批事项。待确认答案、就绪的规格／方案审批和签字会显示在这里。'}</div>
      ) : (
        <div className="inbox-list">
          {visible.map((item) => (
            <article className="panel inbox-item" data-inbox-kind={item.kind} key={item.id}>
              <div><span className="badge">{INBOX_LABEL[item.kind]}</span> <span className="muted">{STAGE_LABEL[item.stage]}</span></div>
              <h2>{item.changeTitle}</h2>
              <div className="muted"><code>{item.changeId}</code> · {item.kind === 'question-confirmation'
                ? `${item.questionId} · 第 ${item.rev} 版答案`
                : item.kind === 'human-signoff' ? `提交 ${item.sha.slice(0, 12)}` : `内容 ${item.contentHash.slice(0, 12)}`}</div>
              <a href={inboxHref(item)}>查看并处理</a>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
