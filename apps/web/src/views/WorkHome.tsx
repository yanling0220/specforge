import { useState } from 'react';
import type { HumanRole } from '@specforge/shared';
import { api, API_BASE } from '../api.ts';
import { useData, useQuestionRead, useVisibleRefresh } from '../live.ts';
import { href, inboxHref, INBOX_LABEL } from '../model.ts';
import { roleLabel, workListState, WORK_ACTION } from '../question-work.ts';

export function WorkHome({ role, name, alternate, onSwitch, version }: {
  role: HumanRole; name: string; alternate?: HumanRole; onSwitch: (role: HumanRole) => void; version: number;
}) {
  const [refresh, setRefresh] = useState(0);
  const visible = useVisibleRefresh();
  const questions = useQuestionRead(async (signal) => {
    const page = await api.questionWork(role, undefined, undefined, signal);
    // A Web update can be served by a server that is still running the previous read contract.
    const action = page.nextAction ?? page.items.find((item) => item.status !== 'waiting');
    if (action) return { ...page, nextAction: action };
    const status = (['confirm', 'revise', 'answer'] as const).find((value) => page.counts[value] > 0);
    if (!status) return page;
    const current = await api.questionWork(role, status, undefined, signal);
    if (!current.items.length && current.counts.answer + current.counts.revise + current.counts.confirm > 0) {
      throw new Error('问题刚有更新，请重新读取');
    }
    return { ...page, counts: current.counts, nextAction: current.items[0] };
  }, [role, version, refresh, visible]);
  const approvals = useData(() => api.inbox(role), [role, version, refresh, visible]);
  const counts = questions.loading || questions.error ? undefined : questions.data?.counts;
  const action = counts ? questions.data?.nextAction : undefined;
  const approvalItems = approvals.loading || approvals.error ? undefined : approvals.data?.items.filter((item) => item.kind !== 'question-confirmation');
  const approval = approvalItems?.[0];
  const actionable = counts ? counts.answer + counts.revise + counts.confirm : 0;
  const waiting = counts?.waiting ?? 0;
  const pending = questions.loading || approvals.loading;
  const failed = questions.error || approvals.error;
  const empty = !pending && !failed && !action && !approval;
  const resetList = () => {
    Object.assign(workListState(API_BASE, name, role), { status: '', focus: undefined, scroll: 0 });
  };

  return <div className="work-home">
    <h1>我的待办</h1>
    <p className="work-role">当前以{roleLabel(role)}身份工作</p>
    {action ? <section className="panel work-start" aria-label="建议先处理">
      <p className="work-start-label">建议先处理</p>
      <h2>{action.question}</h2>
      <p className="muted">{action.changeTitle} · {action.questionId}</p>
      <a className="btn primary" onClick={resetList} href={href({ page: 'change', id: action.changeId, tab: 'analysis', qid: action.questionId })}>
        {WORK_ACTION[action.status]}
      </a>
    </section> : approval ? <section className="panel work-start" aria-label="建议先处理">
      <p className="work-start-label">建议先处理</p>
      <h2>{approval.changeTitle}</h2>
      <a className="btn primary" href={inboxHref(approval)}>{INBOX_LABEL[approval.kind]}</a>
    </section> : empty ? <section className="panel work-start" role="status">
      <h2>{waiting ? '你这边的操作已完成' : '当前角色没有待办'}</h2>
      <p>{waiting ? '还有问题在等其他角色处理。' : '可以查看变更看板了解项目进展。'}</p>
      {alternate
        ? <button className="btn primary" onClick={() => onSwitch(alternate)}>查看{roleLabel(alternate)}待办</button>
        : <a className="btn primary" href={href({ page: 'board' })}>打开变更看板</a>}
    </section> : pending && <p role="status">正在读取{roleLabel(role)}待办…</p>}
    {failed && <div className="error" role="alert">
      {questions.error && approvals.error ? '待办读取失败' : questions.error ? '问题待办读取失败' : '审批待办读取失败'}。
      <button className="btn" onClick={() => setRefresh((n) => n + 1)}>重新读取</button>
    </div>}
    <nav className="work-shortcuts" aria-label="查看其他工作">
      {(actionable > 0 || waiting > 0) && <a href={href({ page: 'inbox' })} onClick={resetList}>
        查看问题（{actionable} 项可处理{waiting > 0 && `，${waiting} 项等其他角色`}）
      </a>}
      {!!approvalItems?.length && <a href={href({ page: 'inbox', approvals: true })}>查看审批（{approvalItems.length} 项）</a>}
      {!(empty && !alternate) && <a href={href({ page: 'board' })}>查看变更看板</a>}
    </nav>
  </div>;
}
