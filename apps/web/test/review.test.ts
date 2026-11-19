import { afterEach, describe, expect, it, vi } from 'vitest';
import { href, parseRoute, type Route } from '../src/model.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Web 代码审查（T4.7c）', () => {
  it('从部署前缀与项目入口读取快照及所选文件，详情跳转保留当前文档', async () => {
    const base = '/console/team/p/a';
    const url = new URL('https://example.test' + base + '/#/changes/same/review');
    vi.stubGlobal('document', { querySelector: () => ({ getAttribute: () => '/console/team' }) });
    vi.stubGlobal('location', url);
    const mock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ changeId: 'same', snapshotVersion: 'v1' }))
      .mockResolvedValueOnce(Response.json({ snapshotVersion: 'v1', file: { file: { id: 'f1' }, kind: 'text', patch: '+a' } }));
    vi.stubGlobal('fetch', mock);
    const { projectHref } = await import('../src/project.ts');
    const { readReviewSnapshot, readReviewFile } = await import('../src/review-read.ts');
    const signal = new AbortController().signal;
    const route = parseRoute(url.hash);
    expect(route).toEqual({ page: 'change', id: 'same', tab: 'review' });
    expect(projectHref('a', href(route))).toBe(base + '/#/changes/same/review');
    const links: Route[] = [
      { page: 'change', id: 'same', tab: 'gates' },
      { page: 'change', id: 'same', tab: 'analysis', qid: 'Q-1' },
      { page: 'evidence', id: 'same', eid: 'ev-123' },
    ];
    for (const link of links) {
      const destination = new URL(href(link), url);
      expect(destination.pathname).toBe(base + '/');
      expect(parseRoute(destination.hash)).toEqual(link);
    }
    const snapshot = await readReviewSnapshot('same', signal);
    await expect(readReviewFile('same', snapshot.snapshotVersion, 'f1', signal)).resolves.toMatchObject({ patch: '+a' });
    expect(mock.mock.calls.map(([path]) => path)).toEqual([
      base + '/api/changes/same/review',
      base + '/api/changes/same/review/files/f1?snapshot=v1',
    ]);
    expect(mock.mock.calls.map(([, init]) => init)).toEqual([
      { credentials: 'same-origin', cache: 'no-store', signal },
      { credentials: 'same-origin', cache: 'no-store', signal },
    ]);
  });

  it('忽略切换文件或快照后迟到的旧成功与失败响应', async () => {
    const { watchReviewRead } = await import('../src/review-read.ts');
    const first = deferred<string>();
    const second = deferred<string>();
    const last = deferred<string>();
    const receive = vi.fn();
    const loadFirst = vi.fn((_: AbortSignal) => first.promise);
    const stopFirst = watchReviewRead(loadFirst, receive);
    stopFirst();
    expect(loadFirst.mock.calls[0]![0].aborted).toBe(true);
    const stopSecond = watchReviewRead(() => second.promise, receive);
    stopSecond();
    watchReviewRead(() => last.promise, receive);
    last.resolve('current');
    await last.promise;
    first.resolve('old patch');
    second.reject(new Error('old snapshot failed'));
    await Promise.allSettled([first.promise, second.promise]);
    expect(receive.mock.calls).toEqual([[{ data: 'current' }]]);
  });

  it('串行队列跳过已经取消的文件读取，继续读取新快照', async () => {
    const first = deferred<Response>();
    const mock = vi.fn<typeof fetch>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(Response.json({ changeId: 'same', snapshotVersion: 'v2' }));
    vi.stubGlobal('fetch', mock);
    const { api } = await import('../src/api.ts');
    const { readReviewSnapshot, readReviewFile, watchReviewRead } = await import('../src/review-read.ts');
    const busy = api.chain();
    const old = vi.fn();
    const cancel = watchReviewRead((signal) => readReviewFile('same', 'v1', 'old', signal), old);
    cancel();
    const snapshot = readReviewSnapshot('same', new AbortController().signal);
    first.resolve(Response.json({ ok: true }));
    await busy;
    await expect(snapshot).resolves.toMatchObject({ snapshotVersion: 'v2' });
    expect(old).not.toHaveBeenCalled();
    expect(mock.mock.calls.map(([path]) => path)).toEqual(['/api/log/verify', '/api/changes/same/review']);
  });

  it('文件响应必须与快照版本及文件 ID 同时匹配', async () => {
    const mock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ snapshotVersion: 'v1', file: { file: { id: 'selected' } } }))
      .mockResolvedValueOnce(Response.json({ snapshotVersion: 'v2', file: { file: { id: 'another' } } }))
      .mockResolvedValueOnce(Response.json({ error: { code: 'review_stale', message: '请刷新' } }, { status: 409 }));
    vi.stubGlobal('fetch', mock);
    const { readReviewFile, reviewReadError } = await import('../src/review-read.ts');
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = readReviewFile('same', 'v2', 'selected', new AbortController().signal);
      await expect(result.catch(reviewReadError)).resolves.toBe('stale');
    }
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('审计故障需要重新核对整个快照，单文件超限或超时保留其它区域', async () => {
    const mock = vi.fn<typeof fetch>();
    for (const [status, code] of [[503, 'review_unavailable'], [413, 'review_too_large'], [503, 'review_timeout']] as const) {
      mock.mockResolvedValueOnce(Response.json({ error: { code, message: code } }, { status }));
    }
    vi.stubGlobal('fetch', mock);
    const { readReviewFile, reviewReadError } = await import('../src/review-read.ts');
    for (const scope of ['snapshot', 'file', 'file']) {
      const result = readReviewFile('same', 'v2', 'selected', new AbortController().signal);
      await expect(result.catch(reviewReadError)).resolves.toBe(scope);
    }
  });

  it('保留补丁原文并分别编号上下文、删除、新增与后续 hunk', async () => {
    const { numberedPatch } = await import('../src/review-read.ts');
    const patch = [
      '--- a/a', '+++ b/a', '@@ -19,2 +20,2 @@', ' context', '--- not a file header', '+++ <tag>',
      '\\ No newline at end of file', '@@ -39,0 +40 @@', '+new hunk',
    ];
    const lines = numberedPatch(patch.join('\n')).split('\n');
    expect(lines.map((line) => line.slice(15))).toEqual(patch);
    expect(lines.map((line) => line.slice(0, 13).trim().split(/\s+/).filter(Boolean))).toEqual([
      [], [], [], ['19', '20'], ['20'], ['21'], [], [], ['40'],
    ]);
    expect(lines[4]!.slice(0, 6).trim()).toBe('20');
    expect(lines[5]!.slice(7, 13).trim()).toBe('21');
  });
});
