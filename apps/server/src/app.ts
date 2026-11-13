import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { Hono, type Context } from 'hono';
import { ForgeError, isResolved, missingRoles, pausedTasks, pipelineFor, publicUsers, resolveIdentity, upstreamGates, verifyChain } from '@specforge/core';
import {
  advance,
  approve,
  confirmRestatement,
  decideAssumption,
  evaluateAll,
  factsTree,
  questionAction,
  readTasksFacts,
  signOff,
  uncommittedSpecChanges,
  type QuestionOp,
  type Store,
} from '@specforge/store';
import type { Actor, ReviewFinding, Role } from '@specforge/shared';
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

/** 校验客户端提交的打回问题 */
function parseFindings(v: unknown): ReviewFinding[] {
  if (!Array.isArray(v)) throw new ForgeError('bad_arg', 'findings 必须是数组');
  return v.map((f, i) => {
    const o = (f ?? {}) as Record<string, unknown>;
    if (o.severity !== 'blocking' && o.severity !== 'non-blocking') throw new ForgeError('bad_arg', `findings[${i}].severity 只能是 blocking|non-blocking`);
    if (typeof o.text !== 'string' || !o.text.trim()) throw new ForgeError('bad_arg', `findings[${i}].text 不能为空`);
    if (o.kind !== undefined && !['missing', 'regression', 'unplanned'].includes(o.kind as string)) throw new ForgeError('bad_arg', `findings[${i}].kind 只能是 missing|regression|unplanned`);
    if (o.anchor !== undefined && typeof o.anchor !== 'string') throw new ForgeError('bad_arg', `findings[${i}].anchor 必须是字符串`);
    return { severity: o.severity, text: o.text, ...(o.kind ? { kind: o.kind as ReviewFinding['kind'] } : {}), ...(o.anchor ? { anchor: o.anchor } : {}) };
  });
}

/** 错误码 → HTTP 状态 */
const STATUS_OF: Record<string, 400 | 403 | 404 | 409> = {
  no_change: 404,
  not_found: 404,
  bad_role: 403,
  forbidden: 403,
  role_not_granted: 403,
  unknown_user: 403,
  disabled: 403,
  no_registry: 403,
  gate_blocked: 409,
  out_of_band: 409,
};

/** 不需要登录的接口 */
const PUBLIC_API = new Set(['/api/health', '/api/auth/me', '/api/auth/login', '/api/auth/logout']);

export function createApp(store: Store, index: ForgeIndex, opts: AppOptions = {}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const auth = opts.auth ?? new Auth(store);

  // 启用用户名册后，除公开接口外都需要登录（含 WebSocket）
  const guard = auth.guard();
  app.use('/api/*', (c, next) => (PUBLIC_API.has(c.req.path) ? next() : guard(c, next)));
  app.use('/ws', guard);
  // 所有 POST 只接受 JSON：跨站表单无法发送，配合 SameSite=Strict 防 CSRF
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'POST' && c.req.path !== '/api/auth/logout' && !c.req.header('content-type')?.startsWith('application/json')) {
      return c.json({ error: { code: 'bad_request', message: '需要 application/json' } }, 415);
    }
    await next();
  });
  mountAuthRoutes(app, auth);

  // 每次请求前与文件同步，保证列表不落后于文件
  app.use('/api/*', async (_, next) => {
    index.sync();
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof ForgeError) {
      const status = STATUS_OF[err.code] ?? 400;
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

  /** 名册的公开视图（不含令牌哈希），供代录时选择对象 */
  app.get('/api/users', (c) => {
    const reg = store.users();
    return c.json({ users: reg ? publicUsers(reg).map(({ name, roles, admin, disabled }) => ({ name, roles, admin, disabled: !!disabled })) : [] });
  });

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

  // ---------------- 写操作（T3.4） ----------------
  // 身份 = 登录用户 + 请求中选择的角色（必须已授予）；没有用户名册时不允许写。
  // 所有修改都经过 @specforge/store 的操作函数，最终走 Store.mutate 写入哈希链。

  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const b = (await c.req.json().catch(() => undefined)) as unknown;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ForgeError('bad_request', '请求体必须是 JSON 对象');
    return b as Record<string, unknown>;
  };
  const str = (b: Record<string, unknown>, key: string, required = false): string | undefined => {
    const v = b[key];
    if (v === undefined || v === null || v === '') {
      if (required) throw new ForgeError('missing_arg', `缺少参数：${key}`);
      return undefined;
    }
    if (typeof v !== 'string') throw new ForgeError('bad_arg', `${key} 必须是字符串`);
    return v;
  };
  const writer = (c: Context<AuthEnv>, b: Record<string, unknown>): Actor => {
    if (!auth.required()) throw new ForgeError('no_registry', '项目还没有启用用户名册：在控制台修改需要登录（sf user add … --admin 启用）');
    const user = c.get('user');
    if (!user) throw new ForgeError('forbidden', '需要登录');
    return resolveIdentity(store.users(), { name: user.name, role: str(b, 'role', true) as Role });
  };
  const proxy = (b: Record<string, unknown>): Actor | undefined => {
    const name = str(b, 'onBehalfName');
    if (!name) return undefined;
    return { name, role: str(b, 'onBehalfRole', true) as Role };
  };

  app.post('/api/changes/:id/questions/:qid/:action', async (c) => {
    const { id, qid, action } = c.req.param();
    const b = await body(c);
    const actor = writer(c, b);
    const ops: Record<string, () => QuestionOp> = {
      answer: () => ({ kind: 'answer', text: str(b, 'text', true)!, optionId: str(b, 'optionId'), reason: str(b, 'reason'), via: str(b, 'via') }),
      confirm: () => ({ kind: 'confirm', onBehalfOf: proxy(b), via: str(b, 'via'), note: str(b, 'note') }),
      reject: () => ({ kind: 'reject', note: str(b, 'note', true)!, onBehalfOf: proxy(b) }),
      defer: () => ({ kind: 'defer', reason: str(b, 'reason', true)! }),
      invalidate: () => ({ kind: 'invalidate', reason: str(b, 'reason', true)! }),
    };
    if (!ops[action]) throw new ForgeError('not_found', `没有这个操作：${action}`);
    return c.json({ question: questionAction(store, id, actor, qid, ops[action]()) });
  });

  app.post('/api/changes/:id/restatement/confirm', async (c) => {
    const b = await body(c);
    confirmRestatement(store, c.req.param('id'), writer(c, b), str(b, 'via'));
    return c.json({ ok: true });
  });

  app.post('/api/changes/:id/assumptions/:aid/decide', async (c) => {
    const b = await body(c);
    const status = str(b, 'status', true);
    if (status !== 'accepted' && status !== 'rejected') throw new ForgeError('bad_arg', 'status 只能是 accepted|rejected');
    decideAssumption(store, c.req.param('id'), writer(c, b), c.req.param('aid'), status, str(b, 'note'));
    return c.json({ ok: true });
  });

  app.post('/api/changes/:id/approve', async (c) => {
    const b = await body(c);
    const target = str(b, 'target', true);
    if (target !== 'spec' && target !== 'design') throw new ForgeError('bad_arg', 'target 只能是 spec|design');
    return c.json({ hash: approve(store, c.req.param('id'), writer(c, b), target, str(b, 'note')) });
  });

  app.post('/api/changes/:id/signoff', async (c) => {
    const b = await body(c);
    const verdict = str(b, 'verdict', true);
    if (verdict !== 'pass' && verdict !== 'fail') throw new ForgeError('bad_arg', 'verdict 只能是 pass|fail');
    const findings = b.findings === undefined ? undefined : parseFindings(b.findings);
    const record = signOff(store, c.req.param('id'), writer(c, b), { verdict, note: str(b, 'note'), findings });
    return c.json({ review: record, change: store.load(c.req.param('id')).change });
  });

  app.post('/api/changes/:id/advance', async (c) => {
    const b = await body(c);
    return c.json(advance(store, c.req.param('id'), writer(c, b)));
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
