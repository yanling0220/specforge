import { statSync } from 'node:fs';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { WSContext } from 'hono/ws';
import type { createNodeWebSocket } from '@hono/node-ws';
import { ForgeError } from '@specforge/core';
import { anchorLog, type Store } from '@specforge/store';
import type { ForgeEvent } from '@specforge/shared';
import { createApp } from './app.ts';
import { Auth } from './auth.ts';
import { createIndex, type IndexConfig } from './index-config.ts';
import type { QueryIndex } from './query-index.ts';
import type { RegisteredProject } from './projects.ts';

export type PushMessage =
  | { type: 'hello'; lastSeq: number }
  | { type: 'event'; event: ForgeEvent }
  | { type: 'changes'; ids: string[] }
  | { type: 'rebuilt' };

interface Client {
  ws: WSContext;
  changeId?: string;
  sid?: string;
}

interface RuntimeOptions {
  store: Store;
  dbPath?: string;
  pollMs?: number;
  webDir?: string;
  basePath?: string;
  project?: RegisteredProject;
  indexConfig?: IndexConfig;
}

export interface ProjectRuntime {
  app: ReturnType<typeof createApp>;
  index: QueryIndex;
  tick(): Promise<void>;
  poll(): Promise<void>;
  close(): Promise<void>;
}

const PAGE = 1000;

export async function createProjectRuntime(opts: RuntimeOptions, upgrade: ReturnType<typeof createNodeWebSocket>['upgradeWebSocket']): Promise<ProjectRuntime> {
  const { store, project } = opts;
  const auth = new Auth(store, Date.now, project ? { cookieName: `sf_session_${project.id}`, cookiePath: opts.basePath, requireRegistry: true } : {});
  const check = () => {
    if (!project) return;
    project.check();
    store.config();
    auth.required();
  };
  check();
  const audit = store.config().audit;
  if (audit !== undefined && (!audit || !Number.isInteger(audit.anchorIntervalMs) || audit.anchorIntervalMs < 1000 || audit.anchorIntervalMs > 2_147_483_647)) {
    throw new ForgeError('bad_arg', 'audit.anchorIntervalMs 必须是 1000–2147483647 的整数（毫秒）');
  }
  const anchor = () => {
    check();
    try {
      anchorLog(store);
    } catch (error) {
      if (!(error instanceof ForgeError && error.code === 'no_events')) throw error;
    }
  };
  if (audit) anchor();
  const index = await createIndex(store, { ...opts, projectId: project?.id });
  try {
    await index.sync({ rebuild: true });
  } catch (error) {
    await index.close();
    throw error;
  }
  const app = createApp(store, index, { auth, webDir: opts.webDir, basePath: opts.basePath, projectId: project?.id, check });
  const clients = new Set<Client>();
  const revoke = (client: Client) => {
    clients.delete(client);
    client.ws.close(1008, '会话失效或项目不可用');
  };
  const allowed = (client: Client) => {
    try {
      check();
      return !auth.required() || !!auth.user(client.sid);
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'write_busy') throw error;
      return false;
    }
  };
  const send = (client: Client, message: PushMessage) => {
    if (!allowed(client)) { revoke(client); return; }
    if (message.type === 'event' && client.changeId && message.event.changeId !== client.changeId) return;
    if (message.type === 'changes' && client.changeId) {
      if (!message.ids.includes(client.changeId)) return;
      message = { type: 'changes', ids: [client.changeId] };
    }
    client.ws.send(JSON.stringify(message));
  };
  const lastSeq = () => store.events().at(-1)?.seq ?? 0;
  const eventsAfter = async (after: number, changeId?: string): Promise<ForgeEvent[]> => {
    const events: ForgeEvent[] = [];
    for (let page = await index.events({ after, changeId, limit: PAGE }); page.length; page = await index.events({ after: page.at(-1)!.seq, changeId, limit: PAGE })) {
      events.push(...page);
      if (page.length < PAGE) break;
    }
    return events;
  };
  let pushedSeq = lastSeq();
  let pushedHash = store.events().at(-1)?.hash;
  let stopped = false;
  let pending: Promise<void> | undefined;
  let syncFailed = false;
  const signature = () => {
    try {
      const stat = statSync(store.path('events.jsonl'));
      return `${stat.size}:${stat.mtimeMs}`;
    } catch { return 'missing'; }
  };
  let seen = signature();
  const update = (force: boolean): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => store.exclusive(async () => {
      check();
      for (const client of clients) if (!allowed(client)) revoke(client);
      const current = signature();
      if (!force && !syncFailed && index.status().backend === 'sqlite' && index.status().state === 'ready' && current === seen) return;
      const { rebuilt } = await index.sync();
      // REST 可能先消费 sync 的 rebuilt 结果；推送自己的游标仍要识别截断 / 重写。
      const rewritten = pushedSeq > 0 && store.events().find((event) => event.seq === pushedSeq)?.hash !== pushedHash;
      if (rebuilt || rewritten) {
        pushedSeq = 0;
        pushedHash = undefined;
        for (const client of clients) send(client, { type: 'rebuilt' });
      }
      const fresh = await eventsAfter(pushedSeq);
      seen = current;
      syncFailed = false;
      if (stopped) return;
      if (!fresh.length) return;
      pushedSeq = fresh.at(-1)!.seq;
      pushedHash = fresh.at(-1)!.hash;
      const ids = [...new Set(fresh.flatMap((event) => event.changeId ? [event.changeId] : []))];
      for (const client of clients) {
        for (const event of fresh) send(client, { type: 'event', event });
        if (ids.length) send(client, { type: 'changes', ids });
      }
    }))().finally(() => { pending = undefined; });
    return pending;
  };
  const tick = () => update(true);
  const validQuery = (context: Context) => {
    const changeId = context.req.query('changeId') || undefined;
    const after = context.req.query('after');
    if (changeId && /[/\\%\0]/.test(changeId)) throw new ForgeError('bad_arg', '无效的 changeId');
    if (after !== undefined && (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))) throw new ForgeError('bad_arg', 'after 必须是非负整数');
    return { changeId, after: after === undefined ? undefined : Number(after) };
  };
  app.get('/ws', (context, next) => { validQuery(context); return next(); }, upgrade((context) => {
    const { changeId, after } = validQuery(context);
    const client: Client = { ws: undefined as unknown as WSContext, changeId, sid: getCookie(context, auth.cookieName) };
    return {
      async onOpen(_, ws) {
        client.ws = ws;
        clients.add(client);
        try {
          await store.exclusive(async () => {
            if (!allowed(client)) { revoke(client); return; }
            await index.sync();
            if (stopped || !allowed(client)) { revoke(client); return; }
            send(client, { type: 'hello', lastSeq: lastSeq() });
            if (after !== undefined) for (const event of (await eventsAfter(after, changeId)).filter((event) => event.seq <= pushedSeq)) send(client, { type: 'event', event });
          });
        } catch (error) {
          if (error instanceof ForgeError && error.code === 'write_busy') { clients.delete(client); client.ws.close(1013, '仓库忙，请重连'); }
          else revoke(client);
        }
      },
      onClose() { clients.delete(client); },
    };
  }));
  const poll = async () => {
    try {
      await update(false);
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'write_busy') return;
      for (const client of clients) revoke(client);
      if (!syncFailed) console.error(project ? `项目 ${project.id} 同步索引失败，请检查项目文件与索引后端` : '同步索引失败，请检查项目文件与索引后端');
      syncFailed = true;
    }
  };
  const timer = setInterval(() => { void poll(); }, opts.pollMs ?? 300);
  const anchorTimer = audit ? setInterval(() => {
    try { anchor(); } catch (error) {
      if (error instanceof ForgeError && error.code === 'write_busy') return;
      if (!project) console.error('日志锚定失败：', error);
      else console.error(`项目 ${project.id} 日志锚定失败，请检查日志与审计分支`);
    }
  }, audit.anchorIntervalMs) : undefined;
  return {
    app, index, tick, poll,
    async close() {
      stopped = true;
      clearInterval(timer);
      clearInterval(anchorTimer);
      for (const client of clients) client.ws.close();
      clients.clear();
      await pending?.catch(() => undefined);
      await index.close();
    },
  };
}
