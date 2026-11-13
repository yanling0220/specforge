import { useEffect, useRef, useState } from 'react';

// 订阅 server 的 WebSocket 推送。收到 event / changes / rebuilt 时 version 加一，
// 页面以 version 作为依赖重新拉取数据（数据本身仍以 REST 读取为准）。

export type LiveStatus = 'connecting' | 'live' | 'offline';

export function useLive(changeId?: string): { version: number; status: LiveStatus } {
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const lastSeq = useRef<number | undefined>(undefined);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry = 0;
    let stopped = false;
    lastSeq.current = undefined;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const params = new URLSearchParams();
      if (changeId) params.set('changeId', changeId);
      if (lastSeq.current !== undefined) params.set('after', String(lastSeq.current));
      ws = new WebSocket(`${proto}://${location.host}/ws?${params}`);
      setStatus('connecting');
      ws.onopen = () => {
        retry = 0;
        setStatus('live');
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as { type: string; lastSeq?: number; event?: { seq: number } };
        if (msg.type === 'hello') {
          // 断线期间可能有变化：重连后刷新一次
          if (lastSeq.current !== undefined && msg.lastSeq !== lastSeq.current) setVersion((v) => v + 1);
          lastSeq.current ??= msg.lastSeq;
          return;
        }
        if (msg.type === 'event' && msg.event) lastSeq.current = Math.max(lastSeq.current ?? 0, msg.event.seq);
        if (msg.type === 'rebuilt') lastSeq.current = 0;
        if (msg.type === 'changes' || msg.type === 'rebuilt') setVersion((v) => v + 1);
      };
      ws.onclose = () => {
        if (stopped) return;
        setStatus('offline');
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15_000));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [changeId]);

  return { version, status };
}

/** 依赖 deps 拉取数据；失败时保留错误，重新拉取时不清空旧数据（避免闪烁） */
export function useData<T>(load: () => Promise<T>, deps: unknown[]): { data?: T; error?: Error; loading: boolean } {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => !cancelled && setState({ data, loading: false }),
      (error: Error) => !cancelled && setState((s) => ({ ...s, error, loading: false })),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
