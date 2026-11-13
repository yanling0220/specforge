import { useEffect } from 'react';
import type { Question, Role } from '@specforge/shared';
import { api, type ChangeDetail } from '../api.ts';
import { useData } from '../live.ts';
import { useMe } from '../me.tsx';
import { Action } from './Action.tsx';
import { buildTree, DIM_STATUS_LABEL, formatTime, href, NODE_KIND_LABEL, Q_STATUS_LABEL, questionHistory, SEVERITY_LABEL, sortQuestions, type TreeNode } from '../model.ts';

// 需求分析视图（只读）：复述、分解树（带问题徽标）、问题卡片与完整核对历史、假设、维度覆盖。
// 登录后可以回答、确认（本人或代录）、驳回、推迟、作废（T3.4）；校验以服务端为准。

export function AnalysisView({ detail, qid, onChanged }: { detail: ChangeDetail; qid?: string; onChanged: () => void }) {
  const { analysis, questions, change } = detail;
  const { roots, orphans } = buildTree(analysis.nodes, questions);
  const r = analysis.restatement;
  const { canWrite, role } = useMe();
  // 代录时选择对象
  const users = useData(() => (canWrite ? api.users() : Promise.resolve([])), [canWrite]);

  // 深链接到某个问题时滚动过去
  useEffect(() => {
    if (qid) document.getElementById(`q-${qid}`)?.scrollIntoView({ block: 'start' });
  }, [qid]);

  return (
    <div className="analysis">
      <section className="panel">
        <h2>需求复述</h2>
        {r ? (
          <>
            <p className="restatement">{r.text}</p>
            <p className={detail.restatementConfirmed ? 'pass' : 'fail'}>
              {detail.restatementConfirmed
                ? `✓ 已由 ${r.confirmation!.actor.name}（${r.confirmation!.role}）确认 · ${formatTime(r.confirmation!.at)}${r.confirmation!.via ? ` · 渠道 ${r.confirmation!.via}` : ''}`
                : r.confirmation
                  ? '✗ 确认后复述被修改，需要重新确认'
                  : '✗ 尚未确认'}
            </p>
            {canWrite && role && !detail.restatementConfirmed && (
              <Action label={`以 ${role} 身份确认复述`} fields={[{ key: 'via', label: '核对渠道（可选）' }]} run={(v) => api.confirmRestatement(change.id, { role, via: v.via || undefined })} onDone={onChanged} />
            )}
          </>
        ) : (
          <p className="muted">还没有需求复述（sf restate 或 sf agent analyze）</p>
        )}
      </section>

      <div className="analysis-grid">
        <section className="panel">
          <h2>
            需求分解树 <small className="muted">{analysis.nodes.length} 个节点</small>
          </h2>
          {roots.length ? (
            <ul className="tree">
              {roots.map((n) => (
                <Node key={n.node.id} t={n} changeId={change.id} selected={qid} />
              ))}
            </ul>
          ) : (
            <p className="muted">还没有分解树</p>
          )}
          {orphans.length > 0 && (
            <>
              <h3 className="muted">未挂到节点的问题</h3>
              <div className="qchips">
                {orphans.map((q) => (
                  <QChip key={q.id} q={q} changeId={change.id} selected={qid} />
                ))}
              </div>
            </>
          )}
        </section>

        <section className="panel">
          <h2>
            问题 <small className="muted">{questions.length} 个 · 未解决 {questions.filter((q) => !detail.questionProgress[q.id]?.resolved).length}</small>
          </h2>
          {questions.length ? (
            sortQuestions(questions).map((q) => (
              <QuestionCard key={q.id} q={q} detail={detail} selected={q.id === qid} users={users.data ?? []} onChanged={onChanged} />
            ))
          ) : (
            <p className="muted">还没有问题</p>
          )}
        </section>
      </div>

      <div className="analysis-grid">
        <section className="panel">
          <h2>假设</h2>
          {analysis.assumptions.length ? (
            <ul className="plain">
              {analysis.assumptions.map((a) => (
                <li key={a.id}>
                  <b>{a.id}</b> {a.text}{' '}
                  <span className={a.status === 'accepted' ? 'pass' : a.status === 'rejected' ? 'fail' : 'warn-text'}>
                    {a.status === 'accepted' ? '✓ 已确认' : a.status === 'rejected' ? '✗ 已否决' : '待决定'}
                  </span>
                  {canWrite && role && a.status === 'pending' && (
                    <span className="inline-actions">
                      <Action label="确认" run={() => api.decideAssumption(change.id, a.id, { role, status: 'accepted' })} onDone={onChanged} />
                      <Action label="否决" danger fields={[{ key: 'note', label: '否决原因', required: true }]} run={(v) => api.decideAssumption(change.id, a.id, { role, status: 'rejected', note: v.note })} onDone={onChanged} />
                    </span>
                  )}
                  {a.decidedBy && (
                    <span className="muted">
                      {' '}
                      · {a.decidedBy.name} {formatTime(a.decidedAt)}
                      {a.note ? ` · ${a.note}` : ''}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">没有假设</p>
          )}
        </section>

        <section className="panel">
          <h2>分析维度</h2>
          <table className="dims">
            <tbody>
              {analysis.dimensions.map((d) => (
                <tr key={d.dimension} className={`dim-${d.status}`}>
                  <td>{d.dimension}</td>
                  <td>{DIM_STATUS_LABEL[d.status]}</td>
                  <td className="muted">
                    {d.reason}
                    {d.questionIds?.map((id) => (
                      <a key={id} href={href({ page: 'change', id: change.id, tab: 'analysis', qid: id })}>
                        {' '}
                        {id}
                      </a>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function Node({ t, changeId, selected }: { t: TreeNode; changeId: string; selected?: string }) {
  return (
    <li>
      <div className="tree-node">
        <span className={`kind kind-${t.node.kind}`}>{NODE_KIND_LABEL[t.node.kind]}</span> {t.node.title} <code className="muted">{t.node.id}</code>
        {t.openBlocking > 0 && <span className="badge bad">{t.openBlocking} 阻塞</span>}
      </div>
      {t.questions.length > 0 && (
        <div className="qchips">
          {t.questions.map((q) => (
            <QChip key={q.id} q={q} changeId={changeId} selected={selected} />
          ))}
        </div>
      )}
      {t.children.length > 0 && (
        <ul>
          {t.children.map((c) => (
            <Node key={c.node.id} t={c} changeId={changeId} selected={selected} />
          ))}
        </ul>
      )}
    </li>
  );
}

function QChip({ q, changeId, selected }: { q: Question; changeId: string; selected?: string }) {
  return (
    <a className={`qchip sev-${q.severity} st-${q.status} ${selected === q.id ? 'selected' : ''}`} href={href({ page: 'change', id: changeId, tab: 'analysis', qid: q.id })} title={q.question}>
      {q.id} · {Q_STATUS_LABEL[q.status]}
    </a>
  );
}

type UserRow = { name: string; roles: Role[]; disabled: boolean };

function QuestionCard({ q, detail, selected, users, onChanged }: { q: Question; detail: ChangeDetail; selected: boolean; users: UserRow[]; onChanged: () => void }) {
  const progress = detail.questionProgress[q.id];
  const current = q.revisions.at(-1);
  const paused = Object.entries(detail.pausedTasks)
    .filter(([, qs]) => qs.includes(q.id))
    .map(([t]) => t);

  return (
    <article id={`q-${q.id}`} className={`qcard sev-${q.severity} ${selected ? 'selected' : ''}`}>
      <header>
        <b>{q.id}</b>
        <span className={`badge sev-${q.severity}`}>{SEVERITY_LABEL[q.severity]}</span>
        <span className="badge">{q.category}</span>
        <span className={`badge st-${q.status}`}>{Q_STATUS_LABEL[q.status]}</span>
        {q.nodeId && <code className="muted">{q.nodeId}</code>}
      </header>
      <p className="qtext">{q.question}</p>
      {q.why && <p className="muted">为什么问：{q.why}</p>}
      {q.evidence && <p className="muted">依据：{q.evidence}</p>}
      {q.options.length > 0 && (
        <ul className="options">
          {q.options.map((o) => (
            <li key={o.id} className={current?.optionId === o.id && q.status !== 'open' ? 'chosen' : ''}>
              <b>{o.id}.</b> {o.text}
              {o.impact && <span className="muted">（{o.impact}）</span>}
              {o.recommended && <span className="badge">推荐</span>}
              {q.defaultOptionId === o.id && <span className="badge">默认</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="small">
        需要确认：{q.requiredRoles.join(' + ')}
        {progress && !progress.resolved && progress.missingRoles.length > 0 && <span className="warn-text"> · 当前版本还缺 {progress.missingRoles.join('、')}</span>}
        {q.dependsOn.length > 0 && <span className="muted"> · 依赖 {q.dependsOn.join(', ')}</span>}
        {(q.taskIds?.length ?? 0) > 0 && <span className="muted"> · 关联任务 {q.taskIds!.join(', ')}</span>}
        {paused.length > 0 && <span className="fail"> · 暂停中：{paused.join(', ')}</span>}
      </p>
      <QuestionActions key={current ? `${current.rev}:${current.hash}` : 'unanswered'} q={q} changeId={detail.change.id} missing={progress?.missingRoles ?? []} users={users} onChanged={onChanged} />
      <details open={selected}>
        <summary>核对历史（{q.revisions.length} 个版本）</summary>
        <ol className="history">
          {questionHistory(q).map((h, i) => (
            <li key={i} className={`h-${h.kind}`}>
              <span className="muted">{formatTime(h.at)}</span> {h.rev && <code>v{h.rev}</code>} <b>{h.actor.name}</b>
              <span className="muted">（{h.actor.role}）</span> {h.text}
              {h.recordedBy && <span className="warn-text">（由 {h.recordedBy.name} 代录{h.via ? `，渠道：${h.via}` : ''}）</span>}
              {!h.recordedBy && h.via && <span className="muted">（渠道：{h.via}）</span>}
            </li>
          ))}
          {q.revisions.some((r) => r.state === 'superseded') && <li className="muted small">被新版本取代的答案仍保留在历史中，不可删改</li>}
        </ol>
      </details>
    </article>
  );
}

/** 问题的写操作：按状态与当前角色显示可用的操作 */
function QuestionActions({ q, changeId, missing, users, onChanged }: { q: Question; changeId: string; missing: Role[]; users: UserRow[]; onChanged: () => void }) {
  const { canWrite, role } = useMe();
  if (!canWrite || !role || q.status === 'invalidated' || q.status === 'deferred') return null;
  const current = q.revisions.at(-1);
  const reference = { rev: current?.rev, answerHash: current?.hash };
  const run = (action: Parameters<typeof api.questionAction>[2]) => (v: Record<string, string>) =>
    api.questionAction(changeId, q.id, action, { role, ...(action === 'confirm' || action === 'reject' ? reference : {}), ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '')) });
  const confirmed = q.status === 'confirmed';
  // 代录对象：名册中拥有尚缺角色的其他用户
  const proxyOptions = users
    .filter((u) => !u.disabled)
    .flatMap((u) => u.roles.filter((r) => missing.includes(r)).map((r) => ({ value: `${u.name}:${r}`, label: `${u.name}（${r}）` })));

  return (
    <div className="inline-actions">
      <Action
        label={confirmed ? '修改答案' : q.revisions.length ? '提交新版本答案' : '回答'}
        fields={[
          ...(q.options.length ? [{ key: 'optionId', label: '选项', kind: 'select' as const, options: [{ value: '', label: '（不选）' }, ...q.options.map((o) => ({ value: o.id, label: `${o.id}. ${o.text}` }))] }] : []),
          { key: 'text', label: '答案', kind: 'textarea', required: true },
          ...(confirmed ? [{ key: 'reason', label: '修改原因（已确认的答案必须写）', required: true }] : []),
          { key: 'via', label: '核对渠道（可选）' },
        ]}
        run={run('answer')}
        onDone={onChanged}
      />
      {q.status === 'drafted' && missing.includes(role) && (
        <Action label={`以 ${role} 身份确认`} fields={[{ key: 'note', label: '说明（可选）' }]} run={run('confirm')} onDone={onChanged} />
      )}
      {q.status === 'drafted' && proxyOptions.length > 0 && (
        <Action
          label="代录确认"
          fields={[
            { key: 'subject', label: '代谁确认', kind: 'select', options: proxyOptions },
            { key: 'via', label: '核对渠道（会议纪要、IM 链接等）', required: true },
            { key: 'note', label: '说明（可选）' },
          ]}
          run={(v) => {
            const [onBehalfName, onBehalfRole] = v.subject!.split(':');
            return api.questionAction(changeId, q.id, 'confirm', { role, ...reference, onBehalfName, onBehalfRole, via: v.via, ...(v.note ? { note: v.note } : {}) });
          }}
          onDone={onChanged}
        />
      )}
      {q.status === 'drafted' && <Action label="驳回" danger fields={[{ key: 'note', label: '驳回意见', kind: 'textarea', required: true }]} run={run('reject')} onDone={onChanged} />}
      {!confirmed && <Action label="推迟" fields={[{ key: 'reason', label: '推迟原因', required: true }]} run={run('defer')} onDone={onChanged} />}
      <Action label="作废" danger fields={[{ key: 'reason', label: '作废原因', required: true }]} run={run('invalidate')} onDone={onChanged} />
    </div>
  );
}
