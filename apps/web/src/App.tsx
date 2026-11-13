import { useEffect, useState } from 'react';
import { api, UNAUTHORIZED_EVENT, type SessionUser } from './api.ts';
import { useData, useLive, type LiveStatus } from './live.ts';
import { href, parseRoute, type Route } from './model.ts';
import { Board } from './views/Board.tsx';
import { ChangeView } from './views/ChangeView.tsx';
import { EvidenceView } from './views/EvidenceView.tsx';
import { Login } from './views/Login.tsx';
import { Timeline } from './views/Timeline.tsx';

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

const LIVE_TEXT: Record<LiveStatus, string> = { connecting: '连接中', live: '实时', offline: '已断开，重连中' };

export function App() {
  const [authVersion, setAuthVersion] = useState(0);
  const me = useData(() => api.me(), [authVersion]);
  useEffect(() => {
    const on = () => setAuthVersion((v) => v + 1);
    window.addEventListener(UNAUTHORIZED_EVENT, on);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, on);
  }, []);
  if (!me.data) return <div className="app"><main>{me.error ? <div className="error">无法连接 server：{me.error.message}</div> : null}</main></div>;
  if (me.data.required && !me.data.user) return <div className="app"><main><Login onLogin={() => setAuthVersion((v) => v + 1)} /></main></div>;
  const logout = me.data.user ? () => void api.logout().then(() => setAuthVersion((v) => v + 1)) : undefined;
  return <Console user={me.data.user} onLogout={logout} />;
}

function Console({ user, onLogout }: { user: SessionUser | null; onLogout?: () => void }) {
  const route = useRoute();
  const changeId = route.page === 'change' || route.page === 'evidence' ? route.id : undefined;
  const live = useLive(changeId);
  const chain = useData(() => api.chain(), [live.version]);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={href({ page: 'board' })}>
          SpecForge
        </a>
        <nav>
          <a className={route.page === 'board' ? 'active' : ''} href={href({ page: 'board' })}>
            看板
          </a>
          <a className={route.page === 'events' ? 'active' : ''} href={href({ page: 'events' })}>
            全部事件
          </a>
        </nav>
        <span className="spacer" />
        {chain.data && (
          <span className={`pill ${chain.data.ok ? 'ok' : 'bad'}`} title={chain.data.ok ? '' : [...chain.data.chainProblems.map((p) => `#${p.seq} ${p.problem}`), ...chain.data.outOfBand.map((o) => `${o.changeId}：${o.problem}`)].join('\n')}>
            {chain.data.ok ? `哈希链完整 · ${chain.data.events} 条事件` : '哈希链 / 状态文件异常'}
          </span>
        )}
        <span className={`live ${live.status}`}>● {LIVE_TEXT[live.status]}</span>
        {user ? (
          <span className="me">
            {user.name}
            <span className="muted">（{user.roles.join(', ')}{user.admin ? '，管理员' : ''}）</span>
            <button className="link" onClick={onLogout}>
              退出
            </button>
          </span>
        ) : (
          <span className="muted small" title="项目没有启用用户名册：sf user add 启用后需要登录">未启用登录</span>
        )}
      </header>
      <main>
        {route.page === 'board' && <Board version={live.version} />}
        {route.page === 'events' && <Timeline version={live.version} />}
        {route.page === 'change' && <ChangeView id={route.id} tab={route.tab} qid={route.qid} version={live.version} />}
        {route.page === 'evidence' && <EvidenceView id={route.id} eid={route.eid} />}
      </main>
      <footer>只读控制台 · 所有修改仍通过 sf 命令完成</footer>
    </div>
  );
}
