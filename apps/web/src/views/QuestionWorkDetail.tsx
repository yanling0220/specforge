import { useEffect, useRef, useState } from 'react';
import type { AnswerDraftInput, HumanRole, QuestionWorkAction, QuestionWorkDetail as Detail, QuestionWorkStatus } from '@specforge/shared';
import { ApiError, api, API_BASE } from '../api.ts';
import { useData, useQuestionRead, useVisibleRefresh } from '../live.ts';
import { questionHistory, formatTime, href, Q_STATUS_LABEL, SEVERITY_LABEL } from '../model.ts';
import { draftKey, initialQuestionDraft, leaveQuestionEvent, readQuestionDraft, roleLabel, rolesLabel, saveQuestionDraft, workListState, WORK_ACTION, WORK_LABEL, type QuestionDraft } from '../question-work.ts';
import { Loading } from './common.tsx';
import { Action } from './Action.tsx';

async function nextQuestion(role: HumanRole, status: QuestionWorkStatus | '', preferred: QuestionWorkStatus | undefined, current: string, signal: AbortSignal) {
  const find = async (filter?: QuestionWorkStatus) => {
    let cursor: string | undefined;
    do {
      const page = await api.questionWork(role, filter, cursor, signal);
      const eligible = (item: typeof page.items[number]) => item.status !== 'waiting'
        && href({ page: 'change', id: item.changeId, tab: 'analysis', qid: item.questionId }) !== current;
      const match = page.nextAction && eligible(page.nextAction) ? page.nextAction : page.items.find(eligible);
      if (match) return match;
      cursor = page.nextCursor;
    } while (cursor);
  };
  if (status === 'waiting') return;
  if (status) return find(status);
  if (preferred && preferred !== 'waiting') {
    const match = await find(preferred);
    if (match) return match;
  }
  return find();
}

export function QuestionWorkDetailView({ changeId, questionId, version, name, role }: {
  changeId: string; questionId: string; version: number; name: string; role: HumanRole;
}) {
  const [refresh, setRefresh] = useState(0);
  const visibleVersion = useVisibleRefresh();
  const result = useQuestionRead((signal) => api.questionWorkDetail(changeId, questionId, role, signal), [changeId, questionId, role, version, refresh, visibleVersion]);
  const reload = () => setRefresh((n) => n + 1);
  if (!result.data) return <><a href="#/inbox">返回问题列表</a><Loading error={result.error} />{result.error && <button className="btn" onClick={reload}>重试读取问题</button>}</>;
  return <QuestionEditor key={result.data.draftScope} detail={result.data} name={name} loading={result.loading}
    readError={result.error} reload={reload} version={version + refresh + visibleVersion} />;
}

function QuestionEditor({ detail, name, loading, readError, reload, version }: {
  detail: Detail; name: string; loading: boolean; readError?: Error; reload: () => void; version: number;
}) {
  const { role, changeId, question: q } = detail;
  const questionId = q.id;
  const current = q.revisions.at(-1);
  const key = draftKey(API_BASE, detail);
  const [stored] = useState(() => {
    try { return { draft: readQuestionDraft(sessionStorage, key), failed: false }; }
    catch { return { draft: undefined, failed: true }; }
  });
  const [draft, setDraft] = useState(stored.draft ?? initialQuestionDraft(detail));
  const [storageFailed, setStorageFailed] = useState(stored.failed);
  const [receipt, setReceipt] = useState<{ text: string; preferred?: QuestionWorkStatus }>();
  const [failure, setFailure] = useState<{ message: string; unknown?: boolean }>();
  const [busy, setBusy] = useState(false);
  const [writePendingRead, setWritePendingRead] = useState(false);
  const [editing, setEditing] = useState(!!stored.draft);
  const pending = useRef(false);
  const receiptPanel = useRef<HTMLElement>(null);
  const editor = useRef<HTMLFormElement>(null);
  const lastWriteView = useRef<Detail | undefined>(undefined);
  const can = (action: QuestionWorkAction) => detail.actions.includes(action);
  const needsReview = draft.touched && draft.base !== detail.questionVersion;
  const canWrite = !loading && !readError && !busy && !writePendingRead && !failure?.unknown;
  const option = q.options.find((x) => x.id === draft.optionId);
  const preview = draft.mode === 'free' ? draft.text : option
    ? option.text + (draft.supplement.trim() ? '\n\n' + draft.supplement.trim() : '') : '';
  const view = workListState(API_BASE, name, role);
  const currentPath = href({ page: 'change', id: changeId, tab: 'analysis', qid: questionId });
  const restoreListPosition = () => { view.focus ??= '#/inbox'; };
  const next = useQuestionRead((signal) => receipt
    ? nextQuestion(role, view.status, receipt.preferred, currentPath, signal) : Promise.resolve(undefined),
  [role, view.status, receipt, version]);
  const users = useData(() => can('record') ? api.users() : Promise.resolve([]), [detail.questionVersion, role, can('record')]);

  useEffect(() => {
    if (writePendingRead && !loading && detail !== lastWriteView.current) {
      setWritePendingRead(false);
    }
  }, [detail, loading, writePendingRead]);
  useEffect(() => {
    setDraft((value) => value.touched ? value : initialQuestionDraft(detail));
  }, [detail]);
  useEffect(() => { if (receipt) receiptPanel.current?.focus(); }, [receipt]);
  useEffect(() => {
    if (!draft.touched || !storageFailed) return;
    const leave = () => window.confirm('草稿未能保存到此标签页。确定要离开并放弃当前输入吗？');
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (link && !leave()) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const onLeave = (event: Event) => { if (!leave()) event.preventDefault(); };
    const onHash = (event: HashChangeEvent) => {
      if (event.newURL !== event.oldURL && !leave()) {
        history.replaceState(history.state, '', event.oldURL);
        event.stopImmediatePropagation();
      }
    };
    const onFollow = (event: MouseEvent) => {
      // Hash changes are also used by the back button. A confirmed link only needs one prompt.
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (link && !event.defaultPrevented) acceptedHash = (link as HTMLAnchorElement).href;
    };
    let acceptedHash: string | undefined;
    const onNavigate = (event: HashChangeEvent) => {
      if (event.newURL !== acceptedHash) onHash(event);
      acceptedHash = undefined;
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('click', onFollow, true);
    window.addEventListener('hashchange', onNavigate, true);
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener(leaveQuestionEvent, onLeave);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('click', onFollow, true);
      window.removeEventListener('hashchange', onNavigate, true);
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener(leaveQuestionEvent, onLeave);
    };
  }, [draft.touched, storageFailed]);

  const update = (patch: Partial<QuestionDraft>) => {
    const value = { ...draft, ...patch, touched: true };
    setDraft(value);
    setEditing(true);
    setReceipt(undefined);
    try {
      saveQuestionDraft(sessionStorage, API_BASE, key, value);
      setStorageFailed(false);
    } catch { setStorageFailed(true); }
  };
  const discard = () => {
    try { sessionStorage.removeItem(key); } catch { /* current input can still be discarded */ }
    setDraft(initialQuestionDraft(detail));
    setStorageFailed(false);
    setEditing(false);
  };
  const run = async (write: () => Promise<{ question: Detail['question']; questionVersion?: string }>, message: (saved: Detail['question']) => string, clearDraft = false) => {
    if (!canWrite || pending.current) return;
    pending.current = true;
    lastWriteView.current = detail;
    setBusy(true);
    setFailure(undefined);
    try {
      const saved = await write();
      if (!saved.question || !saved.questionVersion) throw new Error('提交响应缺少问题版本');
      if (clearDraft) discard();
      setReceipt({ text: message(saved.question), preferred: detail.status });
      setWritePendingRead(true);
      reload();
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.status >= 500 || cause.code === 'http') {
        setFailure({ message: '未能确认提交结果。请刷新问题，核对当前答案和历史后再决定是否重试。', unknown: true });
      } else {
        setFailure({ message: cause.code === 'write_busy' ? '项目正忙。当前输入已保留，请稍后手动重试。' : cause.message });
      }
      if (!(cause instanceof ApiError) || cause.code !== 'write_busy') {
        setWritePendingRead(true);
        reload();
      }
      throw cause;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const act = (kind: 'confirm' | 'reject' | 'defer' | 'invalidate', fields: Record<string, string> = {}) => {
    const ref = current ? { rev: current.rev, answerHash: current.hash } : {};
    return run(() => api.questionAction(changeId, questionId, kind, { role, baseQuestionVersion: detail.questionVersion, ...ref, ...fields }),
      (saved) => {
        const missing = saved.requiredRoles.filter((r) => !saved.revisions.at(-1)?.confirmations.some((c) => c.role === r));
        return {
          confirm: `已确认第 ${current?.rev} 版答案，${missing.length ? `等待${rolesLabel(missing)}确认` : '此问题已处理完成'}`,
          reject: `已退回第 ${current?.rev} 版答案，等待${rolesLabel(saved.requiredRoles)}提交新答案`,
          defer: '已推迟此问题', invalidate: '已作废此问题',
        }[kind];
      });
  };
  const submit = () => {
    if (needsReview || !preview.trim()) return;
    const common = { reason: draft.reason.trim() || undefined };
    const input: AnswerDraftInput = draft.mode === 'option'
      ? { ...common, mode: 'option', optionId: draft.optionId, supplement: draft.supplement }
      : { ...common, mode: 'free', text: draft.text, optionId: option?.id };
    void run(() => api.submitQuestionAnswer(changeId, questionId, role, draft.base, input), (saved) => {
      const revision = saved.revisions.at(-1)!;
      const missing = saved.requiredRoles.filter((r) => !revision.confirmations.some((c) => c.role === r));
      return `已提交第 ${revision.rev} 版答案，${missing.length ? `等待${rolesLabel(missing)}确认` : '已完成确认'}`;
    }, true).catch(() => {});
  };
  const primaryEditor = !receipt && (detail.status === 'answer' || detail.status === 'revise');
  const editorOpen = can('submit-answer') && (primaryEditor || editing);
  const answerModeChosen = !q.options.length || !!current || draft.touched;
  const showEditor = () => {
    setReceipt(undefined);
    setEditing(true);
    requestAnimationFrame(() => editor.current?.focus());
  };
  const relatedRoles = q.requiredRoles.filter((r) => r !== role);
  const proxyOptions = (users.data ?? []).filter((u) => !u.disabled).flatMap((u) => u.roles.filter((r) => detail.missingRoles.includes(r)).map((r) => ({
    value: JSON.stringify([u.name, r]), label: `${u.name}（${roleLabel(r)}）`,
  })));

  return <section id={`q-${questionId}`} className="question-work-detail selected">
    <nav className="crumbs" aria-label="问题位置">
      <a href="#/inbox" onClick={restoreListPosition}>问题列表</a> / <a href={href({ page: 'change', id: changeId, tab: 'analysis' })}>{detail.changeTitle}</a> / {questionId}
    </nav>
    <header className="question-detail-head">
      <div className="work-meta">
        <span className={`badge work-${detail.status ?? 'history'}`}>{detail.status ? WORK_LABEL[detail.status] : detail.delivered ? '已交付 · 只读' : Q_STATUS_LABEL[q.status]}</span>
        <span className={`badge sev-${q.severity}`}>{SEVERITY_LABEL[q.severity]}</span>
      </div>
      <h1 className="qtext">{q.question}</h1>
      {detail.status === 'waiting' && !receipt && <p className="waiting-guidance">
        等待{rolesLabel(detail.missingRoles)}确认。<a href={href({ page: 'home' })}>返回我的待办</a>
      </p>}
      {!detail.status && !receipt && <p className="muted">{detail.delivered ? '该变更已交付。' : '当前角色没有待办。'}{' '}
        <a href={href({ page: 'home' })}>返回我的待办</a></p>}
      {(q.why || q.evidence) && <details className="question-background">
        <summary>查看问题背景</summary>{q.why && <p>{q.why}</p>}{q.evidence && <p>依据 · {q.evidence}</p>}
      </details>}
      {q.closure && <p className="muted">{q.closure.reason}</p>}
    </header>
    {loading && <p className="muted small" role="status">正在核对当前版本…</p>}
    {readError && <div className="error" role="alert">问题暂时无法核对。{readError.message} <button className="btn" onClick={reload}>重试读取问题</button></div>}
    {receipt && <section ref={receiptPanel} className="work-receipt panel" tabIndex={-1} aria-label="处理结果" aria-live="polite">
      <b>{receipt.text}</b>
      <div className="action-buttons">
        {!next.loading && !next.error && next.data && <a className="btn primary" href={href({ page: 'change', id: next.data.changeId, tab: 'analysis', qid: next.data.questionId })}>
          {WORK_ACTION[next.data.status]} · 下一项</a>}
        {!next.loading && !next.error && !next.data && <a className="btn primary" href={href({ page: 'home' })}>返回我的待办</a>}
        <a className="btn" href="#/inbox" onClick={restoreListPosition}>返回问题列表</a>
        {next.loading && <span className="muted">正在读取下一项…</span>}
        {next.error && <button className="btn" onClick={reload}>重试读取下一项</button>}
      </div>
      {!next.loading && !next.error && next.data && <p className="muted">下一项 · {next.data.question}</p>}
      {!next.loading && !next.error && !next.data && <p className="muted">{view.status ? '当前筛选下没有下一项可处理的问题。' : '当前角色没有其他问题需要处理。'}</p>}
    </section>}
    {current && <section className="panel answer-current">
      <h2>{current.state === 'rejected' ? '退回的答案' : '当前答案'} · 第 {current.rev} 版</h2>
      {current.rejection && <div className="banner warn"><b>退回意见 · {current.rejection.actor.name}</b><p>{current.rejection.note}</p></div>}
      {detail.status === 'revise' ? <details><summary>查看原答案</summary><p className="work-answer">{current.text}</p></details>
        : <p className="work-answer">{current.text}</p>}
      {(can('confirm') || can('reject')) && <div className="inline-actions" key={detail.questionVersion}>
        <p className="work-instruction">请核对这版答案。认可就确认，需要修改就退回并写明原因。</p>
        {can('confirm') && <button className="btn primary" disabled={!canWrite} onClick={() => void act('confirm').catch(() => {})}>确认此答案</button>}
        {can('reject') && <Action label="退回并要求修订" disabled={!canWrite} danger fields={[{ key: 'note', label: '退回理由', kind: 'textarea', required: true }]}
          run={(v) => act('reject', v)} onDone={() => {}} />}
      </div>}
      <p className="muted small">由 {current.proposedBy.name} 提交{current.state === 'confirmed' ? ' · 已完成确认' : ''}</p>
      {current.confirmations.length > 0 && <details className="answer-confirmations"><summary>查看已确认的人</summary>
        <ul className="plain">{current.confirmations.map((c) => <li key={c.role}>{roleLabel(c.role)} · {c.actor.name}{c.note ? ` · ${c.note}` : ''}</li>)}</ul>
      </details>}
      {!editorOpen && can('submit-answer') && <button className="btn" disabled={!canWrite} onClick={showEditor}>修改答案</button>}
    </section>}
    {failure && <div className="error" role="alert">{failure.message}
      {failure.unknown && <div className="action-buttons">
        <button className="btn" onClick={reload}>刷新问题</button>
        <button className="btn" disabled={loading || !!readError || writePendingRead} onClick={() => setFailure(undefined)}>已核对提交结果</button>
      </div>}
    </div>}
    {editorOpen && <form ref={editor} tabIndex={-1} className="panel answer-editor" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <h2>{current ? '修改答案' : '回答问题'}</h2>
      <p className="muted">{q.requiredRoles.includes(role)
        ? relatedRoles.length ? `提交后交给${rolesLabel(relatedRoles)}确认。` : '提交后此问题即处理完成。'
        : `提交后交给${rolesLabel(q.requiredRoles)}确认。`}</p>
      {(q.options.length > 0 || draft.mode === 'option') && <fieldset className="answer-choices">
        <legend>选择一项作为答案</legend>
        {q.options.map((o) => <label key={o.id}>
          <input type="radio" name="answer-mode" value={o.id} checked={draft.mode === 'option' && draft.optionId === o.id}
            onChange={() => update({ mode: 'option', optionId: o.id })} />
          <span><b>{o.text}</b>{o.recommended && ' · 推荐'}{o.impact && <span className="muted">{o.impact}</span>}</span>
        </label>)}
        <label>
          <input type="radio" name="answer-mode" value="free" checked={draft.mode === 'free' && answerModeChosen}
            onChange={() => update({ mode: 'free', optionId: current?.optionId ?? '' })} />
          <span>自己填写答案</span>
        </label>
      </fieldset>}
      {answerModeChosen && (draft.mode === 'option' ? <>
        <label>补充说明（可选）<textarea value={draft.supplement} rows={3} onChange={(e) => update({ supplement: e.target.value })} /></label>
        <div className="answer-preview"><b>提交正文预览</b><p className="work-answer">{preview || '请重新选择有效选项。'}</p></div>
      </> : <label>答案<textarea placeholder="填写你的决定或建议" value={draft.text} rows={5} onChange={(e) => update({ text: e.target.value })} required /></label>)}
      {current?.state === 'confirmed' && <label>修订原因<textarea value={draft.reason} rows={2} onChange={(e) => update({ reason: e.target.value })} required /></label>}
      {needsReview && <div className="banner warn" role="alert">
        <p>问题已更新。草稿仍保留，请核对上方当前答案和确认状态。</p>
        <button type="button" className="btn" disabled={!canWrite} onClick={() => update({ base: detail.questionVersion })}>已核对，继续编辑草稿</button>
      </div>}
      <p className={storageFailed ? 'fail small' : 'muted small'} role="status">{storageFailed
        ? '浏览器未能保存草稿，当前输入仍保留在本页。'
        : draft.touched ? '草稿已保存在此标签页' : '编辑内容会保存到此标签页'}</p>
      <div className="action-buttons">
        <button type="submit" className="btn primary" disabled={!canWrite || needsReview || !preview.trim() || (current?.state === 'confirmed' && !draft.reason.trim())}>
          {busy ? '正在提交…' : current ? '提交新版本' : '提交答案'}
        </button>
        {draft.touched && <button type="button" className="btn" disabled={busy} onClick={discard}>放弃草稿</button>}
      </div>
    </form>}
    {!editorOpen && draft.touched && <section className="panel">
      <h2>保留的草稿</h2><p className="work-answer">{preview || draft.text || draft.supplement}</p>
      <button className="btn" onClick={discard}>放弃草稿</button>
    </section>}
    {!editorOpen && q.options.length > 0 && <details className="panel"><summary>可选方案</summary><ul className="options">{q.options.map((o) =>
      <li key={o.id}>{o.text}{o.recommended && ' · 推荐'}{o.impact && <div className="muted">{o.impact}</div>}</li>)}</ul></details>}
    <details className="panel history-panel">
      <summary>处理历史（{q.revisions.length} 个版本）</summary>
      <ol className="history">{questionHistory(q).map((event, i) =>
        <li key={i}><span className="muted">{formatTime(event.at)}</span> {event.rev && <code>v{event.rev}</code>} <b>{event.actor.name}</b>（{roleLabel(event.actor.role)}）{event.text}
          {event.recordedBy && ` · 由 ${event.recordedBy.name} 代录`}{event.via && ` · ${event.via}`}</li>)}</ol>
    </details>
    {(proxyOptions.length > 0 || can('defer') || can('invalidate')) && <details className="panel"><summary>其他操作</summary><div className="inline-actions" key={detail.questionVersion}>
      {can('record') && proxyOptions.length > 0 && <Action label="代录确认" disabled={!canWrite} fields={[
        { key: 'subject', label: '确认人', kind: 'select', options: proxyOptions },
        { key: 'via', label: '核对渠道', required: true }, { key: 'note', label: '说明（可选）' },
      ]} run={({ subject, via, note }) => {
        const [onBehalfName, onBehalfRole] = JSON.parse(subject!) as [string, string];
        return act('confirm', { onBehalfName, onBehalfRole, via: via!, note: note ?? '' });
      }} onDone={() => {}} />}
      {can('defer') && <Action label="推迟问题" disabled={!canWrite} fields={[{ key: 'reason', label: '推迟原因', required: true }]} run={(v) => act('defer', v)} onDone={() => {}} />}
      {can('invalidate') && <Action label="作废问题" disabled={!canWrite} danger fields={[{ key: 'reason', label: '作废原因', required: true }]} run={(v) => act('invalidate', v)} onDone={() => {}} />}
    </div></details>}
  </section>;
}
