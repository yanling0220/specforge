import { useEffect, useRef, useState } from 'react';
import { QUESTION_WORK_STATUSES, type HumanRole, type InboxItem, type QuestionWorkItem, type QuestionWorkStatus } from '@specforge/shared';
import { ApiError, api, API_BASE } from '../api.ts';
import { useData, useQuestionRead, useVisibleRefresh } from '../live.ts';
import { href, INBOX_LABEL, inboxHref, SEVERITY_LABEL, STAGE_LABEL } from '../model.ts';
import { roleLabel, rolesLabel, WORK_ACTION, WORK_LABEL, workListState } from '../question-work.ts';
import { Loading } from './common.tsx';

export function Inbox({ role, name, version, approvals }: { role: HumanRole; name: string; version: number; approvals?: boolean }) {
  return <>
    <h1>{approvals ? '审批' : '问题列表'} <small className="muted">{roleLabel(role)}身份</small></h1>
    <nav className="work-tabs" aria-label="工作类型">
      <a href="#/inbox" aria-current={!approvals ? 'page' : undefined}>问题</a>
      <a href="#/inbox/approvals" aria-current={approvals ? 'page' : undefined}>其他审批</a>
    </nav>
    {approvals ? <Approvals role={role} version={version} /> : <QuestionList role={role} name={name} version={version} />}
  </>;
}

function QuestionList({ role, name, version }: { role: HumanRole; name: string; version: number }) {
  const view = workListState(API_BASE, name, role);
  const [status, setStatus] = useState(view.status);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState('');
  const visibleVersion = useVisibleRefresh();
  const first = useRef<HTMLSelectElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const cursor = cursors.at(-1);
  const result = useQuestionRead((signal) => api.questionWork(role, status || undefined, cursor, signal), [role, status, cursor, version, refresh, visibleVersion]);
  const counts = result.data?.counts;
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  const items = result.data?.items;
  const actionable = items?.filter((item) => item.status !== 'waiting') ?? [];
  const waiting = items?.filter((item) => item.status === 'waiting') ?? [];
  const cursorStale = result.error instanceof ApiError && result.error.code === 'stale_cursor';
  useEffect(() => {
    if (!cursorStale) return;
    setCursors([undefined]);
    setNotice('问题列表已更新，已返回第一页。');
  }, [cursorStale]);

  useEffect(() => {
    if (!items || result.loading || result.error || view.focus === undefined) return;
    const target = [...(list.current?.querySelectorAll<HTMLAnchorElement>('a') ?? [])].find((a) => a.hash === view.focus);
    (target ?? first.current)?.focus({ preventScroll: true });
    window.scrollTo(0, view.scroll);
    view.focus = undefined;
  }, [items, result.loading, result.error, view]);

  const updateFilter = (selected: QuestionWorkStatus | '') => {
    view.status = selected;
    setStatus(selected);
    setCursors([undefined]);
    setNotice('');
  };
  const renderItem = (item: QuestionWorkItem) => {
    const link = href({ page: 'change', id: item.changeId, tab: 'analysis', qid: item.questionId });
    return <article className="panel inbox-item question-work-item" data-question-status={item.status} key={link}>
      <div className="work-meta">
        <span className={`badge work-${item.status}`}>{WORK_LABEL[item.status]}</span>
        <span className={`badge sev-${item.severity}`}>{SEVERITY_LABEL[item.severity]}</span>
        <span className="muted">{item.changeTitle} · {item.questionId}</span>
      </div>
      <h3>{item.question}</h3>
      {item.answer && <p className="work-answer">第 {item.answer.rev} 版答案 · {item.answer.text}</p>}
      {item.answer?.rejection && <p className="warn-text">退回意见 · {item.answer.rejection}</p>}
      {item.status === 'waiting' && <p className="muted">等待{rolesLabel(item.missingRoles)}确认</p>}
      <a className="btn" href={link} aria-label={`${WORK_ACTION[item.status]}：${item.question}`}
        onClick={() => { view.focus = link; view.scroll = window.scrollY; }}>{WORK_ACTION[item.status]}</a>
    </article>;
  };

  return <>
    <div className="inbox-toolbar">
      <label>问题状态{' '}
        <select ref={first} value={status} onChange={(event) => updateFilter(event.target.value as QuestionWorkStatus | '')}>
          <option value="">全部{counts ? `（${total}）` : ''}</option>
          {QUESTION_WORK_STATUSES.map((value) => <option key={value} value={value}>{WORK_LABEL[value]}{counts ? `（${counts[value]}）` : ''}</option>)}
        </select>
      </label>
      <button className="btn" disabled={result.loading} onClick={() => setRefresh((n) => n + 1)}>刷新</button>
      {result.loading && <span className="muted" role="status">正在核对…</span>}
    </div>
    {notice && <p className="muted" role="status">{notice}</p>}
    {result.error && !cursorStale && <div className="error" role="alert">暂时无法读取问题。{result.error.message}</div>}
    {!result.error && !result.loading && (items?.length ? <>
      <div ref={list}>
        {actionable.length > 0 && <section className="inbox-list" aria-label="可以处理的问题">
          <h2>可以处理</h2>{actionable.map(renderItem)}
        </section>}
        {waiting.length > 0 && <section className="inbox-list" aria-label="等待其他角色的问题">
          <h2>等其他角色处理</h2>{waiting.map(renderItem)}
        </section>}
        {!actionable.length && !status && counts && counts.answer + counts.revise + counts.confirm > 0 &&
          <p className="muted">本页只有等待中的问题。可以按问题状态筛选，直接查看需要回答、修改或确认的问题。</p>}
      </div>
      {(cursors.length > 1 || result.data?.nextCursor) && <div className="action-buttons">
        <button className="btn" disabled={cursors.length === 1} onClick={() => setCursors((c) => c.slice(0, -1))}>上一页</button>
        <span>第 {cursors.length} 页</span>
        <button className="btn" disabled={!result.data?.nextCursor} onClick={() => setCursors((c) => [...c, result.data!.nextCursor])}>下一页</button>
      </div>}
    </> : <div className="panel muted" role="status">{total ? '当前筛选下没有问题。' : '本角色暂无问题待处理。'}{' '}
      {total > 0 && <button className="btn" onClick={() => updateFilter('')}>查看全部问题</button>}
      {!total && <a href={href({ page: 'home' })}>返回我的待办</a>}
    </div>)}
  </>;
}

function Approvals({ role, version }: { role: HumanRole; version: number }) {
  const [refresh, setRefresh] = useState(0);
  const [kind, setKind] = useState<InboxItem['kind'] | ''>('');
  useEffect(() => {
    const timer = setInterval(() => setRefresh((value) => value + 1), 15_000);
    return () => clearInterval(timer);
  }, []);
  const result = useData(() => api.inbox(role), [role, version, refresh]);
  const items = result.data?.items.filter((item) => item.kind !== 'question-confirmation');
  const visible = items?.filter((item) => !kind || item.kind === kind);
  return <>
    <div className="inbox-toolbar">
      <label>事项类型{' '}
        <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          <option value="">全部</option>
          {Object.entries(INBOX_LABEL).filter(([value]) => value !== 'question-confirmation').map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <button className="btn" onClick={() => setRefresh((n) => n + 1)} disabled={result.loading}>刷新</button>
    </div>
    {!items ? <Loading error={result.error} /> : !visible?.length
      ? <div className="panel muted" role="status">{items.length ? '当前类型没有待处理事项。' : '当前角色暂无其他审批待处理。'}</div>
      : <div className="inbox-list">{visible.map((item) =>
        <article className="panel inbox-item" data-inbox-kind={item.kind} key={item.id}>
          <div><span className="badge">{INBOX_LABEL[item.kind]}</span> <span className="muted">{STAGE_LABEL[item.stage]}</span></div>
          <h2>{item.changeTitle}</h2>
          <div className="muted"><code>{item.changeId}</code> · {item.kind === 'human-signoff' ? `提交 ${item.sha.slice(0, 12)}` : `内容 ${item.contentHash.slice(0, 12)}`}</div>
          <a className="btn" href={inboxHref(item)}>{INBOX_LABEL[item.kind]}</a>
        </article>)}</div>}
  </>;
}
