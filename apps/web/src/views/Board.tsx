import { api } from '../api.ts';
import { useData } from '../live.ts';
import { attentionReasons, boardColumns, formatTime, href, STAGE_LABEL } from '../model.ts';
import { Loading } from './common.tsx';

export function Board({ version }: { version: number }) {
  const { data, error } = useData(() => api.changes(), [version]);
  if (!data) return <Loading error={error} />;
  if (!data.length) return <div className="muted">还没有 change。在项目中运行 sf change new 创建。</div>;
  const waiting = data.filter((c) => attentionReasons(c).length).length;

  return (
    <>
      <h1>
        看板 <small className="muted">{data.length} 个 change{waiting ? ` · ${waiting} 个在等人` : ''}</small>
      </h1>
      {error && <div className="error">刷新失败：{error.message}</div>}
      <div className="board">
        {boardColumns(data).map((col) => (
          <section key={col.stage} className="column">
            <h2>
              {STAGE_LABEL[col.stage]} <span className="count">{col.changes.length}</span>
            </h2>
            {col.changes.map((c) => {
              const reasons = attentionReasons(c);
              return (
                <a key={c.id} className={`card ${reasons.length ? 'attention' : ''}`} href={href({ page: 'change', id: c.id, tab: 'gates' })}>
                  <div className="card-title">
                    {reasons.length > 0 && <span className="dot" title={reasons.join('；')} />}
                    {c.title}
                  </div>
                  <div className="card-meta">
                    <code>{c.id}</code> · {c.tier} 档
                  </div>
                  {reasons.map((r) => (
                    <div key={r} className="reason">
                      {r}
                    </div>
                  ))}
                  <div className="card-time muted">{c.lastEventAt ? `最近活动 ${formatTime(c.lastEventAt)}` : ''}</div>
                </a>
              );
            })}
          </section>
        ))}
      </div>
    </>
  );
}
