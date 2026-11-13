import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { ForgeError } from '@specforge/core';
import type { Store } from '@specforge/store';
import { createProjectRuntime, type ProjectRuntime } from './project-runtime.ts';
import type { AuthEnv } from './auth.ts';
import type { ForgeIndex } from './index-db.ts';
import { registerProjects, type ProjectRegistration } from './projects.ts';

export type { PushMessage } from './project-runtime.ts';

export interface ServerOptions {
  store: Store;
  host?: string;
  port?: number;
  dbPath?: string;
  pollMs?: number;
  webDir?: string;
}

export const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface RunningServer {
  url: string;
  index: ForgeIndex;
  tick(): void;
  close(): Promise<void>;
}

export interface MultiProjectOptions {
  projects: ProjectRegistration[];
  host?: string;
  port?: number;
  pollMs?: number;
}

export interface RunningMultiProjectServer {
  url: string;
  tick(): void;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
export const isLoopback = (host: string) => LOOPBACK.has(host);

async function listen(app: Hono<AuthEnv>, sockets: ReturnType<typeof createNodeWebSocket>, opts: { host?: string; port?: number }, runtimes: ProjectRuntime[]): Promise<RunningMultiProjectServer> {
  let server: ServerType;
  try {
    server = await new Promise<ServerType>((resolve, reject) => {
      const listening = serve({ fetch: app.fetch, hostname: opts.host ?? '127.0.0.1', port: opts.port ?? 4317 }, () => resolve(listening));
      listening.once('error', reject);
    });
  } catch (error) {
    for (const runtime of runtimes) runtime.close();
    throw error;
  }
  sockets.injectWebSocket(server);
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}`,
    tick: () => { for (const runtime of runtimes) runtime.tick(); },
    close: () => new Promise((resolve, reject) => {
      for (const runtime of runtimes) runtime.close();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  if (!isLoopback(opts.host ?? '127.0.0.1') && !opts.store.users()) {
    throw new ForgeError('no_registry', '项目还没有启用用户名册（没有登录），只能监听本机');
  }
  const app = new Hono<AuthEnv>();
  const sockets = createNodeWebSocket({ app });
  const runtime = createProjectRuntime({ ...opts, webDir: opts.webDir ?? DEFAULT_WEB_DIR }, sockets.upgradeWebSocket);
  app.route('/', runtime.app);
  app.notFound((context) => runtime.app.fetch(context.req.raw));
  const server = await listen(app, sockets, opts, [runtime]);
  return { ...server, index: runtime.index, tick: runtime.tick };
}

export async function startMultiProjectServer(opts: MultiProjectOptions): Promise<RunningMultiProjectServer> {
  const projects = registerProjects(opts.projects);
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
  app.get('/api/health', (context) => context.json({ ok: true, mode: 'multi-project', readOnly: true }));
  for (const project of projects) {
    const basePath = `/p/${project.id}`;
    try {
      const runtime = createProjectRuntime({ store: project.store, project, basePath, pollMs: opts.pollMs }, sockets.upgradeWebSocket);
      runtimes.push(runtime);
      app.route(basePath, runtime.app);
    } catch {
      console.error(`项目 ${project.id} 不可用，检查仓库与用户名册后重启服务`);
      app.all(basePath, unavailable);
      app.all(`${basePath}/*`, unavailable);
    }
  }
  const server = await listen(app, sockets, opts, runtimes);
  return { ...server, tick: () => { for (const runtime of runtimes) runtime.poll(); } };
}
