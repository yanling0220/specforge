import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { deploymentPath, ForgeError } from '@specforge/core';
import type { Store } from '@specforge/store';
import { createProjectRuntime, type ProjectRuntime } from './project-runtime.ts';
import type { AuthEnv } from './auth.ts';
import type { QueryIndex } from './query-index.ts';
import { parseIndexConfig, type IndexConfig } from './index-config.ts';
import { registerProjects, type ProjectRegistration } from './projects.ts';
import { webResponse } from './web.ts';
import { parseNotificationConfig, type NotificationConfig } from './notification-config.ts';
import type { FeishuTransport } from './feishu.ts';
import type { NotificationWorker } from './notification-worker.ts';

export type { PushMessage } from './project-runtime.ts';

export interface ServerOptions {
  store: Store;
  basePath?: string;
  host?: string;
  port?: number;
  dbPath?: string;
  pollMs?: number;
  webDir?: string;
  indexConfig?: IndexConfig;
  notifications?: NotificationConfig;
  notificationTransport?: FeishuTransport;
}

export const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface RunningServer {
  url: string;
  index: QueryIndex;
  notifications?: NotificationWorker;
  tick(): Promise<void>;
  close(): Promise<void>;
}

export interface MultiProjectOptions {
  projects: ProjectRegistration[];
  basePath?: string;
  host?: string;
  port?: number;
  pollMs?: number;
  webDir?: string;
  indexConfig?: IndexConfig;
  notifications?: NotificationConfig;
  notificationTransport?: FeishuTransport;
}

export interface RunningMultiProjectServer {
  url: string;
  tick(): Promise<void>;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
export const isLoopback = (host: string) => LOOPBACK.has(host);

function mountPath(value?: string): string {
  try { return deploymentPath(value); }
  catch { throw new ForgeError('bad_arg', '无效的部署前缀，请使用最多八段的绝对路径'); }
}

async function listen(app: Hono<AuthEnv>, sockets: ReturnType<typeof createNodeWebSocket>, opts: { host?: string; port?: number }, runtimes: ProjectRuntime[]): Promise<RunningMultiProjectServer> {
  let server: ServerType;
  try {
    server = await new Promise<ServerType>((resolve, reject) => {
      const listening = serve({ fetch: app.fetch, hostname: opts.host ?? '127.0.0.1', port: opts.port ?? 4317 }, () => resolve(listening));
      listening.once('error', reject);
    });
  } catch (error) {
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    throw error;
  }
  sockets.injectWebSocket(server);
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}`,
    tick: async () => { await Promise.all(runtimes.map((runtime) => runtime.tick())); },
    close: async () => {
      await Promise.all(runtimes.map((runtime) => runtime.close()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const basePath = mountPath(opts.basePath);
  if (!isLoopback(opts.host ?? '127.0.0.1') && !opts.store.users()) {
    throw new ForgeError('no_registry', '项目还没有启用用户名册（没有登录），只能监听本机');
  }
  const app = new Hono<AuthEnv>();
  const sockets = createNodeWebSocket({ app });
  const notifications = opts.notifications && parseNotificationConfig(opts.notifications);
  if (notifications && notifications.projects.length !== 1) throw new ForgeError('bad_arg', '单项目通知配置必须恰好包含一个稳定项目 ID');
  const notificationSettings = notifications?.projects[0];
  if (notificationSettings && opts.indexConfig?.backend === 'postgres' && opts.indexConfig.projectId && notificationSettings.projectId !== opts.indexConfig.projectId) throw new ForgeError('bad_arg', '通知与索引的项目 ID 必须一致');
  const runtime = await createProjectRuntime({ ...opts, basePath, deploymentPath: basePath, notificationSettings, webDir: opts.webDir ?? DEFAULT_WEB_DIR }, sockets.upgradeWebSocket);
  app.route(basePath || '/', runtime.app);
  app.notFound((context) => {
    if (basePath && context.req.path !== basePath && !context.req.path.startsWith(basePath + '/')) {
      return context.json({ error: { code: 'not_found', message: '没有这个接口' } }, 404);
    }
    return runtime.app.fetch(context.req.raw);
  });
  const server = await listen(app, sockets, opts, [runtime]);
  return { ...server, url: server.url + basePath, index: runtime.index, notifications: runtime.notifications, tick: runtime.tick };
}

export async function startMultiProjectServer(opts: MultiProjectOptions): Promise<RunningMultiProjectServer> {
  const mount = mountPath(opts.basePath);
  const indexConfig = parseIndexConfig(opts.indexConfig ?? { backend: 'sqlite' });
  if (indexConfig.backend === 'postgres' && (indexConfig.projectId || !process.env[indexConfig.connectionStringEnv])) {
    throw new ForgeError('bad_arg', '多项目 Postgres 使用登记 ID；必须设置连接环境变量且不能另设 projectId');
  }
  const projects = registerProjects(opts.projects);
  const notifications = opts.notifications && parseNotificationConfig(opts.notifications);
  if (notifications?.projects.some((entry) => !projects.some((project) => project.id === entry.projectId))) throw new ForgeError('bad_arg', '通知配置包含未登记的项目 ID');
  const app = new Hono<AuthEnv>();
  const sockets = createNodeWebSocket({ app });
  const runtimes: ProjectRuntime[] = [];
  const unavailable = (context: import('hono').Context) => context.json({ error: { code: 'project_unavailable', message: '项目暂不可用，请联系管理员' } }, 503);
  app.onError((_, context) => unavailable(context));
  app.notFound((context) => context.json({ error: { code: 'not_found', message: '没有这个接口' } }, 404));
  app.use('*', async (context, next) => {
    try {
      for (const segment of context.req.path.split('/')) {
        const decoded = decodeURIComponent(segment);
        if (decoded === '.' || decoded === '..' || /[/\\%\0]/.test(decoded)) throw new Error();
      }
    } catch {
      return context.json({ error: { code: 'bad_arg', message: '无效的请求路径' } }, 400);
    }
    await next();
  });
  app.get(mount + '/api/health', (context) => context.json({ ok: true, mode: 'multi-project', readOnly: false }));
  const frontend: import('hono').Handler<AuthEnv> = (context) => webResponse(opts.webDir ?? DEFAULT_WEB_DIR, context.req.path.startsWith(mount + '/assets/') ? context.req.path.slice(mount.length) : '/', mount) ?? context.json({ error: { code: 'web_unavailable', message: 'Web 控制台未构建，请先运行 npm run web:build' } }, 503);
  app.get(mount + '/', frontend);
  if (mount) app.get(mount, frontend);
  app.get(mount + '/assets/*', frontend);
  app.get(mount + '/p/:id', frontend);
  app.get(mount + '/p/:id/', frontend);
  for (const project of projects) {
    const basePath = mount + '/p/' + project.id;
    try {
      const runtime = await createProjectRuntime({ store: project.store, project, basePath, deploymentPath: mount, webDir: opts.webDir ?? DEFAULT_WEB_DIR, pollMs: opts.pollMs, indexConfig,
        notificationSettings: notifications?.projects.find((entry) => entry.projectId === project.id), notificationTransport: opts.notificationTransport,
      }, sockets.upgradeWebSocket);
      runtimes.push(runtime);
      app.route(basePath, runtime.app);
    } catch {
      console.error(`项目 ${project.id} 不可用，检查仓库与用户名册后重启服务`);
      app.all(basePath, unavailable);
      app.all(`${basePath}/*`, unavailable);
    }
  }
  const server = await listen(app, sockets, opts, runtimes);
  return { ...server, url: server.url + mount, tick: async () => { await Promise.all(runtimes.map((runtime) => runtime.poll())); } };
}
