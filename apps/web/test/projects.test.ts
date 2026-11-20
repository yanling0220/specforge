import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessibleProjects, projectBase, projectFromPath, projectHref, socketUrl, visitedProjects } from '../src/project.ts';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('Web 项目上下文（T4.3d）', () => {
  it('从路径而不是 hash / 请求体选择项目，旧单项目入口不变', () => {
    expect(projectFromPath('/')).toBeUndefined();
    expect(projectFromPath('/p/alpha')).toBe('alpha');
    expect(projectFromPath('/p/alpha/')).toBe('alpha');
    expect(projectBase()).toBe('');
    expect(projectBase('alpha')).toBe('/p/alpha');
    expect(projectHref('alpha')).toBe('/p/alpha/#/home');
    expect(projectHref('alpha', '#/inbox')).toBe('/p/alpha/#/inbox');
    expect(projectHref('alpha', '#/changes/same/analysis/Q-1')).toBe('/p/alpha/#/changes/same/analysis/Q-1');
    expect(projectHref('alpha', '#/changes/%ZZ')).toBe('/p/alpha/#/');
    for (const path of ['/p/../', '/p/%61/', '/p/A/', '/p/alpha/changes/demo', '/p/alpha//']) expect(() => projectFromPath(path)).toThrow();
    for (const id of ['', '../a', 'a/b', 'a?token=secret', 'a'.repeat(65)]) expect(() => projectHref(id)).toThrow();
  });

  it('部署前缀同时限定项目入口、根入口和项目链接，不接受前缀之外的路径', () => {
    const base = '/console/team';
    expect(projectFromPath(base + '/', base)).toBeUndefined();
    expect(projectFromPath(base + '/p/a/', base)).toBe('a');
    expect(projectBase(undefined, base)).toBe(base);
    expect(projectBase('a', base)).toBe(base + '/p/a');
    expect(projectHref('a', '#/changes/same/analysis/Q-1', base)).toBe(base + '/p/a/#/changes/same/analysis/Q-1');
    for (const path of ['/p/a/', '/console/team-other/p/a/', '/console/team/p/A/']) {
      expect(() => projectFromPath(path, base)).toThrow();
    }
  });

  it('服务端元数据固定部署与项目上下文，页面位置变化不会把旧表单写入另一项目', async () => {
    vi.stubGlobal('document', { querySelector: () => ({ getAttribute: () => '/console/team' }) });
    vi.stubGlobal('location', { pathname: '/console/team/p/a/' });
    const fake = vi.fn<typeof fetch>(async () => Response.json({ id: 'a', user: null }));
    vi.stubGlobal('fetch', fake);
    const { api, API_BASE } = await import('../src/api.ts');
    expect(API_BASE).toBe('/console/team/p/a');
    await api.me(); await api.login('same', 'secret'); await api.change('same'); await api.inbox('product');
    vi.stubGlobal('location', { pathname: '/console/team/p/b/' });
    await api.questionAction('same', 'Q-1', 'answer', { role: 'dev', text: 'draft A' });
    expect(fake.mock.calls.every(([path]) => String(path).startsWith('/console/team/p/a/api/'))).toBe(true);
    expect(socketUrl(API_BASE, 'https://example.invalid', 'same')).toBe('wss://example.invalid/console/team/p/a/ws?changeId=same');
  });

  it('部署元数据与页面路径不匹配时拒绝 API，不回退到根部署', async () => {
    vi.stubGlobal('document', { querySelector: () => ({ getAttribute: () => '/console/team' }) });
    vi.stubGlobal('location', { pathname: '/p/a/' });
    const fake = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fake);
    const { api, PROJECT_ERROR } = await import('../src/api.ts');
    expect(PROJECT_ERROR).toContain('部署入口');
    await expect(api.me()).rejects.toMatchObject({ code: 'bad_project' });
    expect(fake).not.toHaveBeenCalled();
  });

  it('订阅地址按项目构造，每个新页面从无游标开始，参数只在当前连接内使用', () => {
    expect(socketUrl('/p/a', 'https://example.test', 'same', 99)).toBe('wss://example.test/p/a/ws?changeId=same&after=99');
    expect(socketUrl('/p/b', 'http://example.test', 'same')).toBe('ws://example.test/p/b/ws?changeId=same');
    expect(socketUrl('', 'http://example.test')).toBe('ws://example.test/ws');
  });

  it('访问记录只接受有限个有效 ID，不存路径、凭据或业务名称', () => {
    expect(visitedProjects('not-json')).toEqual([]);
    expect(visitedProjects('{"a":true}')).toEqual([]);
    expect(visitedProjects(JSON.stringify(['a', 'b', 'a', '../escape', { id: 'c', token: 'secret' }, null]))).toEqual(['a', 'b']);
    expect(visitedProjects(JSON.stringify(Array.from({ length: 25 }, (_, index) => `project-${index}`)))).toHaveLength(20);
  });

  it('访问记录不是授权；权限复核失败、项目不匹配、忙或网络失败都不列出', async () => {
    const requests: string[] = [];
    const fake = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      requests.push(path);
      expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
      if (path.includes('/network/')) throw new Error('offline');
      if (path.includes('/busy/')) return Response.json({}, { status: 409 });
      if (path.includes('/revoked/')) return Response.json({}, { status: 401 });
      return Response.json({ id: 'a' });
    });
    expect(await accessibleProjects(['a', 'wrong', 'busy', 'revoked', 'network', '../escape'], fake)).toEqual(['a']);
    expect(requests).toHaveLength(5);
    expect(requests.every((path) => path.endsWith('/api/project'))).toBe(true);
  });

  it('读写、身份和证据请求固定到当前文档的项目，改变 location 不会把旧表单写到新项目', async () => {
    vi.stubGlobal('location', { pathname: '/p/a/' });
    const fake = vi.fn<typeof fetch>(async () => Response.json({ id: 'a', user: null, users: [], events: [], evidence: [] }));
    vi.stubGlobal('fetch', fake);
    const { api, API_BASE } = await import('../src/api.ts');
    expect(API_BASE).toBe('/p/a');
    await api.me(); await api.login('same', 'secret'); await api.change('same'); await api.evidence('same'); await api.project();
    vi.stubGlobal('location', { pathname: '/p/b/' });
    await api.questionAction('same', 'Q-1', 'answer', { role: 'dev', text: 'draft A' });
    expect(fake.mock.calls.every(([path, init]) => String(path).startsWith('/p/a/api/') && init?.credentials === 'same-origin' && init.cache === 'no-store')).toBe(true);
    expect(String(fake.mock.calls.at(-1)![0])).toBe('/p/a/api/changes/same/questions/Q-1/answer');
  });

  it('单项目请求路径兼容，分页请求始终限定同一项目', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({ seq: index + 1 }));
    const fake = vi.fn<typeof fetch>(async (input) => Response.json({ events: String(input).includes('after=0') ? firstPage : [{ seq: 1001 }] }));
    vi.stubGlobal('fetch', fake);
    const { api } = await import('../src/api.ts');
    expect(await api.events('same')).toHaveLength(1001);
    expect(fake.mock.calls.map(([path]) => path)).toEqual(['/api/changes/same/events?limit=1000&after=0', '/api/changes/same/events?limit=1000&after=1000']);
  });

  it('无效项目入口拒绝所有 API，不回退单项目或默认项目', async () => {
    vi.stubGlobal('location', { pathname: '/p/Invalid/' });
    const fake = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fake);
    const { api, PROJECT_ERROR } = await import('../src/api.ts');
    expect(PROJECT_ERROR).toContain('无效');
    await expect(api.me()).rejects.toMatchObject({ code: 'bad_project' });
    expect(fake).not.toHaveBeenCalled();
  });

  it('异步索引造成只读争用时有界重试，项目切换不改变重试上下文', async () => {
    vi.useFakeTimers(); vi.stubGlobal('location', { pathname: '/p/a/' });
    const fake = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: 'write_busy' } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ changes: [{ id: 'same' }] }));
    vi.stubGlobal('fetch', fake);
    const { api } = await import('../src/api.ts');
    const pending = api.changes();
    vi.stubGlobal('location', { pathname: '/p/b/' });
    await vi.runAllTimersAsync();
    expect(await pending).toEqual([{ id: 'same' }]);
    expect(fake.mock.calls.map(([path]) => path)).toEqual(['/p/a/api/changes', '/p/a/api/changes']);
  });

  it('只读重试到达上限时保留 write_busy 错误，不无限请求', async () => {
    vi.useFakeTimers();
    const fake = vi.fn<typeof fetch>(async () => Response.json({ error: { code: 'write_busy' } }, { status: 409 }));
    vi.stubGlobal('fetch', fake);
    const { api } = await import('../src/api.ts');
    const checked = expect(api.changes()).rejects.toMatchObject({ code: 'write_busy' });
    await vi.runAllTimersAsync(); await checked;
    expect(fake).toHaveBeenCalledTimes(7);
  });

  it('业务提交与登录遇到争用也只发送一次', async () => {
    const fake = vi.fn<typeof fetch>(async () => Response.json({ error: { code: 'write_busy' } }, { status: 409 }));
    vi.stubGlobal('fetch', fake);
    const { api } = await import('../src/api.ts');
    await expect(api.questionAction('same', 'Q-1', 'answer', { role: 'dev', text: '一次提交' })).rejects.toMatchObject({ code: 'write_busy' });
    await expect(api.login('same', 'token')).rejects.toMatchObject({ code: 'write_busy' });
    expect(fake).toHaveBeenCalledTimes(2);
    expect(fake.mock.calls.every(([, init]) => init?.method === 'POST')).toBe(true);
  });

  it('断库、版本冲突与网络异常均不自动重试读取', async () => {
    const fake = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: 'index_unavailable' } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ error: { code: 'stale_answer' } }, { status: 409 }))
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fake);
    const { api } = await import('../src/api.ts');
    await expect(api.changes()).rejects.toMatchObject({ code: 'index_unavailable' });
    await expect(api.changes()).rejects.toMatchObject({ code: 'stale_answer' });
    await expect(api.changes()).rejects.toThrow('offline');
    expect(fake).toHaveBeenCalledTimes(3);
  });
});
