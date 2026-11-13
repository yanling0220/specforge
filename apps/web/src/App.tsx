import { useEffect, useState } from 'react';
import type { Role } from '@specforge/shared';
import { api, PROJECT_ERROR, PROJECT_ID, UNAUTHORIZED_EVENT } from './api.ts';
import { MeProvider, useMe } from './me.tsx';
import { useData, useLive, type LiveStatus } from './live.ts';
import { href, parseRoute, type Route } from './model.ts';
import { Board } from './views/Board.tsx';
import { ChangeView } from './views/ChangeView.tsx';
import { EvidenceView } from './views/EvidenceView.tsx';
import { Login } from './views/Login.tsx';
import { Timeline } from './views/Timeline.tsx';
import { ProjectPicker } from './views/ProjectPicker.tsx';
import { rememberProject } from './project.ts';

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
  if (PROJECT_ERROR) return <div className="app"><main><div className="error">{PROJECT_ERROR}</div><a href="/">返回项目入口</a></main></div>;
  return <ConnectedApp />;
}

function ConnectedApp() {
  const mode = useData(async () => {
    if (PROJECT_ID) return 'project';
    const response = await fetch('/api/health', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取服务模式');
    const health = await response.json() as { mode?: string };
    return health.mode === 'multi-project' ? 'picker' : 'single';
  }, []);
  if (!mode.data) return <div className="app"><main>{mode.error ? <div className="error">{mode.error.message}</div> : '正在连接…'}</main></div>;
  if (mode.data === 'picker') return <ProjectPicker />;
  return <ProjectConsole />;
}

function ProjectConsole() {
  const [authVersion, setAuthVersion] = useState(0);
  const me = useData(async () => {
    const session = await api.me();
    if (PROJECT_ID && session.user) {
      const project = await api.project();
      if (project.id !== PROJECT_ID) throw new Error('项目上下文不匹配，拒绝加载');
      rememberProject(PROJECT_ID);
    }
    return session;
  }, [authVersion]);
  useEffect(() => {
    if (!PROJECT_ID || !me.data?.user || me.loading || me.error) return;
    const projectId = PROJECT_ID;
    const remember = () => rememberProject(projectId);
    remember();
    window.addEventListener('hashchange', remember);
    return () => window.removeEventListener('hashchange', remember);
  }, [me.data, me.loading, me.error]);
  useEffect(() => {
    const on = () => {
      if (PROJECT_ID) rememberProject(PROJECT_ID, true);
      setAuthVersion((version) => version + 1);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, on);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, on);
  }, []);
  if (me.loading || me.error || !me.data) return <div className="app"><ProjectHeader /><main>{me.error ? <div className="error">无法连接项目：{me.error.message} <button onClick={() => setAuthVersion((version) => version + 1)}>重试</button></div> : '正在核对登录状态…'}</main></div>;
  if (me.data.required && !me.data.user) return <div className="app"><ProjectHeader /><main><Login onLogin={() => setAuthVersion((v) => v + 1)} /></main></div>;
  const logout = me.data.user ? () => void api.logout().then(() => {
    if (PROJECT_ID) rememberProject(PROJECT_ID, true);
    setAuthVersion((version) => version + 1);
  }).catch(() => setAuthVersion((version) => version + 1)) : undefined;
  return (
    <MeProvider user={me.data.user}>
      <Console onLogout={logout} />
    </MeProvider>
  );
}

function ProjectHeader() {
  return <header className="topbar"><span className="brand">SpecForge</span>{PROJECT_ID && <><span className="project-current">项目：{PROJECT_ID}</span><a className="project-switch" href="/">切换项目</a></>}</header>;
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
        {PROJECT_ID && <><span className="project-current">项目：{PROJECT_ID}</span><a className="project-switch" href="/">切换项目</a></>}
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
