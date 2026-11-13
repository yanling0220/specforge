import { Fragment, useState } from 'react';
import type { ArtifactComment } from '@specforge/shared';
import { api, type ArtifactView } from '../api.ts';
import { useData } from '../live.ts';
import { useMe } from '../me.tsx';
import { COMMENT_STATUS_LABEL, commentsByLine, formatTime } from '../model.ts';
import { Action } from './Action.tsx';
import { Loading } from './common.tsx';

// 产物审阅器（T3.5）：proposal / spec / design / tasks 带行号显示，点行号评论。
// 有待处理评论时，sf agent spec|design|plan 会按评论修订并逐条回应；是否解决由人确认。

const TARGET_LABEL = { spec: '规格', design: '方案', tasks: '任务' } as const;
const AGENT_CMD = { spec: 'spec', design: 'design', tasks: 'plan' } as const;

export function ArtifactsView({ id, version, onChanged }: { id: string; version: number; onChanged: () => void }) {
  const { data, error } = useData(() => api.artifacts(id), [id, version]);
  const [active, setActive] = useState<string>();
  if (!data) return <Loading error={error} />;
  if (!data.files.length) return <p className="muted">还没有可审阅的产物（proposal / spec / design / tasks）</p>;
  const file = data.files.find((f) => f.path === active) ?? data.files[0]!;
  const unresolved = (f: ArtifactView) => f.comments.filter((c) => c.status !== 'resolved').length;

  return (
    <div className="artifacts">
      <nav className="file-list">
        {data.files.map((f) => (
          <button key={f.path} className={f.path === file.path ? 'active' : ''} onClick={() => setActive(f.path)}>
            <span className="badge">{TARGET_LABEL[f.target]}</span> {f.path.split('/').slice(3).join('/')}
            {unresolved(f) > 0 && <span className="badge bad">{unresolved(f)}</span>}
          </button>
        ))}
      </nav>
      <FileView key={file.path} changeId={id} file={file} onChanged={onChanged} />
      {data.orphanComments.length > 0 && (
        <section className="panel">
          <h3 className="muted">文件已不存在的评论</h3>
          {data.orphanComments.map((c) => (
            <CommentCard key={c.id} changeId={id} c={c} onChanged={onChanged} />
          ))}
        </section>
      )}
    </div>
  );
}

function FileView({ changeId, file, onChanged }: { changeId: string; file: ArtifactView; onChanged: () => void }) {
  const { canWrite, role } = useMe();
  const [commentLine, setCommentLine] = useState<number>();
  const { byLine, outdated } = commentsByLine(file.comments);
  const lines = file.text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const open = file.comments.filter((c) => c.status === 'open').length;

  return (
    <section className="panel file-view">
      <h2>
        <code>{file.path}</code>
      </h2>
      {open > 0 && (
        <p className="muted small">
          {open} 条待处理评论：在 {TARGET_LABEL[file.target]} 阶段运行 <code>sf agent {AGENT_CMD[file.target]} {changeId}</code>，agent 会按评论修订并逐条回应；也可以手工修改后确认解决。
        </p>
      )}
      {canWrite && <p className="muted small">点击行号添加评论</p>}
      <table className="code">
        <tbody>
          {lines.map((text, i) => {
            const n = i + 1;
            const here = byLine.get(n) ?? [];
            return (
              <Fragment key={n}>
                <tr className={here.some((c) => c.status !== 'resolved') ? 'has-comment' : ''}>
                  <td className="ln">
                    {canWrite ? (
                      <button className="ln-btn" onClick={() => setCommentLine(commentLine === n ? undefined : n)} title="评论这一行">
                        {n}
                      </button>
                    ) : (
                      n
                    )}
                  </td>
                  <td className="src">
                    <pre>{text || ' '}</pre>
                  </td>
                </tr>
                {(here.length > 0 || commentLine === n) && (
                  <tr className="comment-row">
                    <td />
                    <td>
                      {here.map((c) => (
                        <CommentCard key={c.id} changeId={changeId} c={c} moved={c.anchor.state === 'moved' ? c.line : undefined} onChanged={onChanged} />
                      ))}
                      {commentLine === n && role && (
                        <Action
                          label={`评论第 ${n} 行`}
                          fields={[{ key: 'text', label: '评论（会作为修改意见交给 agent）', kind: 'textarea', required: true }]}
                          run={(v) => api.addComment(changeId, { role, path: file.path, line: n, text: v.text! })}
                          onDone={() => {
                            setCommentLine(undefined);
                            onChanged();
                          }}
                        />
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {outdated.length > 0 && (
        <>
          <h3 className="muted">原文已被修改的评论</h3>
          {outdated.map((c) => (
            <CommentCard key={c.id} changeId={changeId} c={c} onChanged={onChanged} />
          ))}
        </>
      )}
    </section>
  );
}

function CommentCard({ changeId, c, moved, onChanged }: { changeId: string; c: ArtifactComment; moved?: number; onChanged: () => void }) {
  const { canWrite, role } = useMe();
  return (
    <article className={`comment st-${c.status}`}>
      <header>
        <b>{c.id}</b> <span className={`badge cst-${c.status}`}>{COMMENT_STATUS_LABEL[c.status]}</span> <b>{c.by.name}</b>
        <span className="muted">（{c.by.role}）· {formatTime(c.at)}</span>
        {moved !== undefined && <span className="muted"> · 原第 {moved} 行</span>}
      </header>
      <div className="quote">「{c.quote.trim()}」</div>
      <p>{c.text}</p>
      {c.history.map((h, i) => (
        <div key={i} className={`chist ${h.kind}`}>
          <b>{h.by.name}</b>
          <span className="muted">（{h.by.role}）</span>{' '}
          {h.kind === 'addressed' ? (h.response === 'declined' ? '不修改：' : '已修改：') : h.kind === 'resolved' ? '确认解决' : '重新打开：'}
          {h.note && <span>{h.note}</span>} <span className="muted small">{formatTime(h.at)}</span>
        </div>
      ))}
      {canWrite && role && (
        <div className="inline-actions">
          {c.status !== 'resolved' && <Action label="确认解决" fields={[{ key: 'note', label: '说明（可选）' }]} run={(v) => api.commentAction(changeId, c.id, 'resolve', { role, note: v.note || undefined })} onDone={onChanged} />}
          {c.status !== 'open' && <Action label="重新打开" fields={[{ key: 'note', label: '原因', required: true }]} run={(v) => api.commentAction(changeId, c.id, 'reopen', { role, note: v.note })} onDone={onChanged} />}
        </div>
      )}
    </article>
  );
}
