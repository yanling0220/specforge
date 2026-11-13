import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import type { WSContext } from 'hono/ws';
import { ForgeError } from '@specforge/core';
import { anchorLog, type Store } from '@specforge/store';
import type { ForgeEvent } from '@specforge/shared';
import { createApp } from './app.ts';
import { ForgeIndex } from './index-db.ts';

export interface ServerOptions {
  store: Store;
  /** 默认只监听本机：目前没有登录（T4.1），不要暴露到网络上 */
  host?: string;
  /** 0 表示随机端口 */
  port?: number;
  /** 索引文件；默认在内存中，启动时由 .specforge/ 重建 */
  dbPath?: string;
  /** 检查事件日志变化的间隔 */
  pollMs?: number;
  /** Web 控制台构建产物目录；默认 apps/web/dist（不存在则只提供接口） */
  webDir?: string;
}

export const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface RunningServer {
  url: string;
  index: ForgeIndex;
  /** 立即检查一次事件日志并推送（测试和 CLI 写入后可直接调用） */
  tick(): void;
  close(): Promise<void>;
}

/** WebSocket 推送的消息 */
export type PushMessage =
  | { type: 'hello'; lastSeq: number }
  | { type: 'event'; event: ForgeEvent }
  | { type: 'changes'; ids: string[] }
  | { type: 'rebuilt' };

interface Client {
  ws: WSContext;
  changeId?: string;
}

const PAGE = 1000;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
export const isLoopback = (host: string) => LOOPBACK.has(host);

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { store } = opts;
  const audit = store.config().audit;
  if (audit !== undefined && (!audit || !Number.isInteger(audit.anchorIntervalMs) || audit.anchorIntervalMs < 1000 || audit.anchorIntervalMs > 2_147_483_647)) {
    throw new ForgeError('bad_arg', 'audit.anchorIntervalMs 必须是 1000–2147483647 的整数（毫秒）');
  }
  const hostname = opts.host ?? '127.0.0.1';
  // 没有用户名册就没有登录：只允许本机访问
  if (!isLoopback(hostname) && !store.users()) {
    throw new ForgeError('no_registry', `项目还没有启用用户名册（没有登录），只能监听本机。先 sf user add <名字> --role dev --admin，再监听 ${hostname}`);
  }
  const anchor = () => {
    try {
      anchorLog(store);
    } catch (error) {
      if (!(error instanceof ForgeError && error.code === 'no_events')) throw error;
    }
  };
  if (audit) anchor();
  const index = new ForgeIndex(store, opts.dbPath);
  index.sync();
  const app = createApp(store, index, { webDir: opts.webDir ?? DEFAULT_WEB_DIR });
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  const clients = new Set<Client>();

  const send = (client: Client, msg: PushMessage) => {
    if (msg.type === 'event' && client.changeId && msg.event.changeId !== client.changeId) return;
    if (msg.type === 'changes' && client.changeId) {
      // 只订阅一个 change 的客户端只看到它自己的编号
      if (!msg.ids.includes(client.changeId)) return;
      msg = { type: 'changes', ids: [client.changeId] };
    }
    client.ws.send(JSON.stringify(msg));
  };
  const lastSeq = () => store.events().at(-1)?.seq ?? 0;
  /** 分页读取 after 之后的全部事件 */
  const eventsAfter = (after: number, changeId?: string): ForgeEvent[] => {
    const out: ForgeEvent[] = [];
    for (let page = index.events({ after, changeId, limit: PAGE }); page.length; page = index.events({ after: page.at(-1)!.seq, changeId, limit: PAGE })) {
      out.push(...page);
      if (page.length < PAGE) break;
    }
    return out;
  };

  // 推送进度与索引同步分开记录：REST 请求也会同步索引，推送不能因此漏掉事件
  let pushedSeq = lastSeq();
  const tick = () => {
    const { rebuilt } = index.sync();
    if (rebuilt) {
      pushedSeq = 0;
      for (const c of clients) send(c, { type: 'rebuilt' });
    }
    const fresh = eventsAfter(pushedSeq);
    if (!fresh.length) return;
    pushedSeq = fresh.at(-1)!.seq;
    const ids = [...new Set(fresh.flatMap((e) => (e.changeId ? [e.changeId] : [])))];
    for (const c of clients) {
      for (const event of fresh) send(c, { type: 'event', event });
      if (ids.length) send(c, { type: 'changes', ids });
    }
  };

  app.get(
    '/ws',
    upgradeWebSocket((c) => {
      const changeId = c.req.query('changeId') || undefined;
      const after = Number(c.req.query('after') ?? NaN);
      const client: Client = { ws: undefined as unknown as WSContext, changeId };
      return {
        onOpen(_, ws) {
          client.ws = ws;
          clients.add(client);
          send(client, { type: 'hello', lastSeq: lastSeq() });
          // 断线重连：补发 after 之后、已推送范围内的事件
          if (Number.isInteger(after) && after >= 0) for (const event of eventsAfter(after, changeId).filter((e) => e.seq <= pushedSeq)) send(client, { type: 'event', event });
        },
        onClose() {
          clients.delete(client);
        },
      };
    }),
  );

  // 事件日志是所有状态变化的唯一记录：只要监视它即可
  const logFile = store.path('events.jsonl');
  const signature = () => {
    try {
      const s = statSync(logFile);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return 'missing';
    }
  };
  let seen = signature();
  const timer = setInterval(() => {
    const now = signature();
    if (now === seen) return;
    seen = now;
    try {
      tick();
    } catch (e) {
      console.error('同步索引失败：', e);
    }
  }, opts.pollMs ?? 300);

  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, hostname, port: opts.port ?? 4317 }, () => resolve(s));
  });
  injectWebSocket(server);
  const anchorTimer = audit ? setInterval(() => {
    try {
      anchor();
    } catch (error) {
      console.error('日志锚定失败：', error);
    }
  }, audit.anchorIntervalMs) : undefined;
  const addr = server.address() as AddressInfo;
  const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;

  return {
    url: `http://${host}:${addr.port}`,
    index,
    tick,
    close: () =>
      new Promise((resolve, reject) => {
        clearInterval(timer);
        clearInterval(anchorTimer);
        for (const c of clients) c.ws.close();
        server.close((err) => {
          index.close();
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
