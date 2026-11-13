import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { useData, useLive, type LiveStatus } from './live.ts';
import { href, parseRoute, type Route } from './model.ts';
import { Board } from './views/Board.tsx';
import { ChangeView } from './views/ChangeView.tsx';
import { EvidenceView } from './views/EvidenceView.tsx';
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
      </header>
      <main>
        {route.page === 'board' && <Board version={live.version} />}
        {route.page === 'events' && <Timeline version={live.version} />}
        {route.page === 'change' && <ChangeView id={route.id} tab={route.tab} version={live.version} />}
        {route.page === 'evidence' && <EvidenceView id={route.id} eid={route.eid} />}
      </main>
      <footer>只读控制台 · 所有修改仍通过 sf 命令完成</footer>
    </div>
  );
}
