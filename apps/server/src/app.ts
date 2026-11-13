import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { Hono } from 'hono';
import { ForgeError, isResolved, missingRoles, pausedTasks, pipelineFor, upstreamGates, verifyChain } from '@specforge/core';
import { evaluateAll, factsTree, readTasksFacts, uncommittedSpecChanges, type Store } from '@specforge/store';
import { Auth, mountAuthRoutes, type AuthEnv } from './auth.ts';
import type { ForgeIndex } from './index-db.ts';

// 只读 REST 接口（T3.1）。写操作在 T3.4 加入，届时仍然只能走 Store.mutate。
// 列表与过滤查索引；详情、门禁评估、链校验直接读文件并实时计算（不缓存）。

const intParam = (v: string | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ForgeError('bad_arg', `参数必须是非负整数：${v}`);
  return n;
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export interface AppOptions {
  /** Web 控制台构建产物目录（apps/web/dist）；存在时由 server 托管 */
  webDir?: string;
  /** 登录与会话；默认按项目的用户名册新建 */
  auth?: Auth;
}

/** 不需要登录的接口 */
const PUBLIC_API = new Set(['/api/health', '/api/auth/me', '/api/auth/login', '/api/auth/logout']);

export function createApp(store: Store, index: ForgeIndex, opts: AppOptions = {}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const auth = opts.auth ?? new Auth(store);

  // 启用用户名册后，除公开接口外都需要登录（含 WebSocket）
  const guard = auth.guard();
  app.use('/api/*', (c, next) => (PUBLIC_API.has(c.req.path) ? next() : guard(c, next)));
  app.use('/ws', guard);
  mountAuthRoutes(app, auth);

  // 每次请求前与文件同步，保证列表不落后于文件
  app.use('/api/*', async (_, next) => {
    index.sync();
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof ForgeError) {
      const status = err.code === 'no_change' || err.code === 'not_found' ? 404 : 400;
      return c.json({ error: { code: err.code, message: err.message } }, status);
    }
    console.error(err);
    return c.json({ error: { code: 'internal', message: err.message } }, 500);
  });

  app.notFound((c) => {
    const web = opts.webDir;
    const isApi = c.req.path.startsWith('/api/') || c.req.path === '/ws';
    if (c.req.method === 'GET' && !isApi && web && existsSync(join(web, 'index.html'))) {
      // 只允许读 webDir 内的文件；其余路径交给前端路由（index.html）
      const rel = normalize(decodeURIComponent(c.req.path)).replace(/^[/\\]+/, '');
      const file = join(web, rel);
      const inside = file.startsWith(web.endsWith(sep) ? web : web + sep);
      const target = inside && existsSync(file) && statSync(file).isFile() ? file : join(web, 'index.html');
      return c.body(readFileSync(target), 200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    }
    return c.json({ error: { code: 'not_found', message: `没有这个接口：${c.req.method} ${c.req.path}` } }, 404);
  });

  app.get('/api/health', (c) => c.json({ ok: true, root: store.root }));

  app.get('/api/changes', (c) => c.json({ changes: index.changes({ stage: c.req.query('stage') }) }));

  app.get('/api/changes/:id', (c) => {
    const id = c.req.param('id');
    const state = store.load(id);
    const tree = factsTree(store, state);
    return c.json({
      ...state,
      outOfBand: store.outOfBand(id, state) ?? null,
      factsSource: tree.kind === 'commit' ? { kind: 'commit', sha: tree.sha } : { kind: 'worktree' },
      uncommittedSpecChanges: tree.kind === 'commit' ? uncommittedSpecChanges(store, id) : [],
      // 由 core 的规则计算，前端只展示
      restatementConfirmed: !!state.analysis.restatement?.confirmation && state.analysis.restatement.confirmation.hash === state.analysis.restatement.hash,
      questionProgress: Object.fromEntries(state.questions.map((q) => [q.id, { resolved: isResolved(q), missingRoles: isResolved(q) ? [] : missingRoles(q) }])),
      pausedTasks: (() => {
        const tasks = readTasksFacts(store, id, tree);
        return tasks ? Object.fromEntries(pausedTasks(tasks.tasks.filter((t) => !t.done), state.questions)) : {};
      })(),
    });
  });

  app.get('/api/changes/:id/gates', (c) => {
    const id = c.req.param('id');
    const state = store.load(id);
    const gates = evaluateAll(store, state);
    const upstream = upstreamGates(state.change.stage, state.change.tier);
    return c.json({
      stage: state.change.stage,
      pipeline: pipelineFor(state.change.tier),
      gates,
      upstreamInvalid: upstream.filter((g) => gates[g]?.status !== 'passed'),
    });
  });

  app.get('/api/changes/:id/questions', (c) => {
    const id = c.req.param('id');
    store.load(id);
    return c.json({ questions: index.questions(id, { status: c.req.query('status'), severity: c.req.query('severity') }) });
  });

  app.get('/api/changes/:id/questions/:qid', (c) => {
    const { id, qid } = c.req.param();
    const q = store.load(id).questions.find((x) => x.id === qid);
    if (!q) throw new ForgeError('not_found', `问题 ${qid} 不存在`);
    return c.json(q);
  });

  app.get('/api/changes/:id/events', (c) => {
    const id = c.req.param('id');
    store.load(id);
    return c.json({ events: index.events({ changeId: id, type: c.req.query('type'), after: intParam(c.req.query('after')), limit: intParam(c.req.query('limit')) }) });
  });

  app.get('/api/events', (c) =>
    c.json({ events: index.events({ changeId: c.req.query('changeId'), type: c.req.query('type'), after: intParam(c.req.query('after')), limit: intParam(c.req.query('limit')) }) }),
  );

  app.get('/api/changes/:id/evidence', (c) => {
    const id = c.req.param('id');
    store.load(id);
    return c.json({ evidence: store.evidenceIndex(id) });
  });

  app.get('/api/changes/:id/evidence/:eid', (c) => {
    const { id, eid } = c.req.param();
    store.load(id);
    const found = store.readEvidence(id, eid);
    if (!found) throw new ForgeError('not_found', `证据 ${eid} 不存在`);
    return c.json(found);
  });

  app.get('/api/log/verify', (c) => {
    const problems = verifyChain(store.events());
    const outOfBand = store.listChanges().flatMap((id) => {
      const msg = store.outOfBand(id);
      return msg ? [{ changeId: id, problem: msg }] : [];
    });
    return c.json({ ok: !problems.length && !outOfBand.length, events: store.events().length, chainProblems: problems, outOfBand });
  });

  return app;
}
