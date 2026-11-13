import { useEffect, useState } from 'react';
import type { Role } from '@specforge/shared';
import { api, UNAUTHORIZED_EVENT } from './api.ts';
import { MeProvider, useMe } from './me.tsx';
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
  return (
    <MeProvider user={me.data.user}>
      <Console onLogout={logout} />
    </MeProvider>
  );
}

function Console({ onLogout }: { onLogout?: () => void }) {
  const { user, role, setRole } = useMe();
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
          <span className={`pill ${chain.data.ok ? 'ok' : 'bad'}`} title={chain.data.ok
            ? chain.data.anchors.latest ? `已锚定至事件 #${chain.data.anchors.latest.seq}` : '尚未创建日志锚定'
            : [
              ...chain.data.chainProblems.map((problem) => `#${problem.seq} ${problem.problem}`),
              ...chain.data.anchors.problems.map((problem) => `锚定 #${problem.seq} ${problem.problem}`),
              ...chain.data.outOfBand.map((item) => `${item.changeId}：${item.problem}`),
              ...(chain.data.usersProblem ? [`用户名册${chain.data.usersProblem}`] : []),
            ].join('\n')}>
            {chain.data.ok ? `哈希链完整 · ${chain.data.events} 条事件 · ${chain.data.anchors.status === 'passed' ? '已锚定' : '未锚定'}` : '审计校验异常'}
          </span>
        )}
        <span className={`live ${live.status}`}>● {LIVE_TEXT[live.status]}</span>
        {user ? (
          <span className="me">
            {user.name}
            {user.roles.length > 1 ? (
              <select className="role-picker" value={role} onChange={(e) => setRole(e.target.value as Role)} title="以哪个角色操作">
                {user.roles.map((r) => (
                  <option key={r} value={r}>
                    以 {r} 身份
                  </option>
                ))}
              </select>
            ) : (
              <span className="muted">（{role}）</span>
            )}
            {user.admin && <span className="muted">管理员</span>}
            <button className="link" onClick={onLogout}>
              退出
            </button>
          </span>
        ) : (
          <span className="muted small" title="项目没有启用用户名册：sf user add … --admin 启用后需要登录，并可在控制台操作">未启用登录 · 只读</span>
        )}
      </header>
      <main>
        {route.page === 'board' && <Board version={live.version} />}
        {route.page === 'events' && <Timeline version={live.version} />}
        {route.page === 'change' && <ChangeView id={route.id} tab={route.tab} qid={route.qid} version={live.version} />}
        {route.page === 'evidence' && <EvidenceView id={route.id} eid={route.eid} />}
      </main>
      <footer>{user ? `以 ${user.name}（${role}）身份操作；所有修改写入哈希链` : '只读：启用用户名册并登录后可在控制台操作'}</footer>
    </div>
  );
}
