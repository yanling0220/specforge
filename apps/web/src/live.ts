import { useEffect, useRef, useState } from 'react';
import { API_BASE, UNAUTHORIZED_EVENT } from './api.ts';
import { socketUrl } from './project.ts';

// 订阅 server 的 WebSocket 推送。收到 event / changes / rebuilt 时 version 加一，
// 页面以 version 作为依赖重新拉取数据（数据本身仍以 REST 读取为准）。

export type LiveStatus = 'connecting' | 'live' | 'offline';

export function useLive(changeId?: string): { version: number; reconnects: number; status: LiveStatus } {
  const [version, setVersion] = useState(0);
  const [reconnects, setReconnects] = useState(0);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const lastSeq = useRef<number | undefined>(undefined);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry = 0;
    let stopped = false;
    lastSeq.current = undefined;

    const connect = () => {
      ws = new WebSocket(socketUrl(API_BASE, location.origin, changeId, lastSeq.current));
      setStatus('connecting');
      ws.onopen = () => {
        if (retry > 0) setReconnects((v) => v + 1);
        retry = 0;
        setStatus('live');
      };
      ws.onmessage = (e) => {
        if (stopped) return;
        const msg = JSON.parse(String(e.data)) as { type: string; lastSeq?: number; event?: { seq: number } };
        if (msg.type === 'hello') {
          // 首次 REST 读取与订阅建立之间也可能发生修改，首次 hello 同样要刷新。
          if (lastSeq.current === undefined || msg.lastSeq !== lastSeq.current) setVersion((v) => v + 1);
          lastSeq.current ??= msg.lastSeq;
          return;
        }
        if (msg.type === 'event' && msg.event) lastSeq.current = Math.max(lastSeq.current ?? 0, msg.event.seq);
        if (msg.type === 'rebuilt') lastSeq.current = 0;
        if (msg.type === 'changes' || msg.type === 'rebuilt') setVersion((v) => v + 1);
      };
      ws.onclose = (event) => {
        if (stopped) return;
        if (event.code === 1008) {
          window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
          return;
        }
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

  return { version, reconnects, status };
}

export function useVisibleRefresh() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setVersion((v) => v + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  return version;
}

/** 合并短时间内的刷新，撤销已失去上下文的读取。 */
export function useQuestionRead<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  useEffect(() => {
    const controller = new AbortController();
    setState((prev) => ({ data: prev.data, loading: true }));
    const timer = setTimeout(() => {
      load(controller.signal).then(
        (data) => { if (!controller.signal.aborted) setState({ data, loading: false }); },
        (error: Error) => { if (!controller.signal.aborted) setState((prev) => ({ data: prev.data, error, loading: false })); },
      );
    }, 60);
    return () => { clearTimeout(timer); controller.abort(); };
  }, deps);
  return state;
}

/** 重新拉取期间保留数据；失败后清空，避免把旧门禁或旧表单作为当前结果。 */
export function useData<T>(load: () => Promise<T>, deps: unknown[]): { data?: T; error?: Error; loading: boolean } {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => !cancelled && setState({ data, loading: false }),
      (error: Error) => !cancelled && setState({ error, loading: false }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
