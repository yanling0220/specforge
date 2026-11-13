import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessibleProjects, projectBase, projectFromPath, projectHref, socketUrl, visitedProjects } from '../src/project.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('Web 项目上下文（T4.3d）', () => {
  it('从路径而不是 hash / 请求体选择项目，旧单项目入口不变', () => {
    expect(projectFromPath('/')).toBeUndefined();
    expect(projectFromPath('/p/alpha')).toBe('alpha');
    expect(projectFromPath('/p/alpha/')).toBe('alpha');
    expect(projectBase()).toBe('');
    expect(projectBase('alpha')).toBe('/p/alpha');
    expect(projectHref('alpha')).toBe('/p/alpha/#/');
    expect(projectHref('alpha', '#/changes/same/analysis/Q-1')).toBe('/p/alpha/#/changes/same/analysis/Q-1');
    expect(projectHref('alpha', '#/changes/%ZZ')).toBe('/p/alpha/#/');
    for (const path of ['/p/../', '/p/%61/', '/p/A/', '/p/alpha/changes/demo', '/p/alpha//']) expect(() => projectFromPath(path)).toThrow();
    for (const id of ['', '../a', 'a/b', 'a?token=secret', 'a'.repeat(65)]) expect(() => projectHref(id)).toThrow();
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
});
