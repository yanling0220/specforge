import { Hono } from 'hono';
import { ForgeError, upstreamGates, verifyChain } from '@specforge/core';
import { evaluateAll, factsTree, uncommittedSpecChanges, type Store } from '@specforge/store';
import type { ForgeIndex } from './index-db.ts';

// 只读 REST 接口（T3.1）。写操作在 T3.4 加入，届时仍然只能走 Store.mutate。
// 列表与过滤查索引；详情、门禁评估、链校验直接读文件并实时计算（不缓存）。

const intParam = (v: string | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ForgeError('bad_arg', `参数必须是非负整数：${v}`);
  return n;
};

export function createApp(store: Store, index: ForgeIndex): Hono {
  const app = new Hono();

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

  app.notFound((c) => c.json({ error: { code: 'not_found', message: `没有这个接口：${c.req.method} ${c.req.path}` } }, 404));

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
    });
  });

  app.get('/api/changes/:id/gates', (c) => {
    const id = c.req.param('id');
    const state = store.load(id);
    const gates = evaluateAll(store, state);
    const upstream = upstreamGates(state.change.stage, state.change.tier);
    return c.json({
      stage: state.change.stage,
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
