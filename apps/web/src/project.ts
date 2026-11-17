import { href, parseRoute } from './model.ts';
import { fetchWithBusyRetry } from './http.ts';
import { deploymentPath } from '../../../packages/core/src/deployment.ts';

export const DEPLOYMENT_BASE = typeof document === 'undefined' ? ''
  : deploymentPath(document.querySelector('meta[name="specforge-base-path"]')?.getAttribute('content') ?? '');
export const VISITED_PROJECTS_KEY = 'specforge.visited-projects' + (DEPLOYMENT_BASE ? '.' + DEPLOYMENT_BASE : '');
export const PROJECT_ROUTE_KEY = 'specforge.project-route.' + (DEPLOYMENT_BASE ? DEPLOYMENT_BASE + '.' : '');

export function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

export function projectFromPath(pathname: string, base = DEPLOYMENT_BASE): string | undefined {
  const prefix = deploymentPath(base);
  if (prefix && pathname !== prefix && !pathname.startsWith(prefix + '/')) {
    throw new Error('无效的部署入口，当前页面不属于配置的前缀');
  }
  const localPath = pathname.slice(prefix.length);
  if (!localPath.startsWith('/p/')) return undefined;
  const match = /^\/p\/([a-z0-9][a-z0-9_-]{0,63})\/?$/.exec(localPath);
  if (!match) throw new Error('无效的项目入口，请使用管理员提供的 /p/<项目ID>/ 链接');
  return match[1];
}

export function projectBase(projectId?: string, base = DEPLOYMENT_BASE): string {
  const prefix = deploymentPath(base);
  if (projectId === undefined) return prefix;
  if (!validProjectId(projectId)) throw new Error('无效的项目 ID');
  return prefix + '/p/' + projectId;
}

export function projectHref(projectId: string, hash = '#/', base = DEPLOYMENT_BASE): string {
  let route = '#/';
  try { route = href(parseRoute(hash)); } catch {}
  return projectBase(projectId, base) + '/' + route;
}

export function visitedProjects(serialized: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(serialized ?? '[]');
    return Array.isArray(parsed) ? [...new Set(parsed.filter(validProjectId))].slice(-20) : [];
  } catch { return []; }
}

export function socketUrl(base: string, origin: string, changeId?: string, after?: number): string {
  const address = new URL(`${base}/ws`, origin);
  address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
  if (changeId) address.searchParams.set('changeId', changeId);
  if (after !== undefined) address.searchParams.set('after', String(after));
  return address.toString();
}

export async function accessibleProjects(candidates: string[], request: typeof fetch = fetch): Promise<string[]> {
  const checked = await Promise.all(candidates.filter(validProjectId).slice(-20).map(async (projectId) => {
    try {
      const response = await fetchWithBusyRetry(`${projectBase(projectId)}/api/project`, { credentials: 'same-origin', cache: 'no-store' }, request);
      if (!response.ok) return undefined;
      const project = await response.json() as { id?: unknown };
      return project.id === projectId ? projectId : undefined;
    } catch { return undefined; }
  }));
  return [...new Set(checked.filter((projectId): projectId is string => projectId !== undefined))];
}

export function rememberProject(projectId: string, remove = false): void {
  try {
    const previous = visitedProjects(sessionStorage.getItem(VISITED_PROJECTS_KEY)).filter((entry) => entry !== projectId);
    sessionStorage.setItem(VISITED_PROJECTS_KEY, JSON.stringify(remove ? previous : [...previous, projectId].slice(-20)));
    if (remove) sessionStorage.removeItem(`${PROJECT_ROUTE_KEY}${projectId}`);
    else sessionStorage.setItem(`${PROJECT_ROUTE_KEY}${projectId}`, location.hash);
  } catch {}
}
