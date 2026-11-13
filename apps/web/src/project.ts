import { href, parseRoute } from './model.ts';

export const VISITED_PROJECTS_KEY = 'specforge.visited-projects';
export const PROJECT_ROUTE_KEY = 'specforge.project-route.';

export function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

export function projectFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith('/p/')) return undefined;
  const match = /^\/p\/([a-z0-9][a-z0-9_-]{0,63})\/?$/.exec(pathname);
  if (!match) throw new Error('无效的项目入口，请使用管理员提供的 /p/<项目ID>/ 链接');
  return match[1];
}

export function projectBase(projectId?: string): string {
  if (projectId === undefined) return '';
  if (!validProjectId(projectId)) throw new Error('无效的项目 ID');
  return `/p/${projectId}`;
}

export function projectHref(projectId: string, hash = '#/'): string {
  let route = '#/';
  try { route = href(parseRoute(hash)); } catch {}
  return `${projectBase(projectId)}/${route}`;
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
      const response = await request(`${projectBase(projectId)}/api/project`, { credentials: 'same-origin', cache: 'no-store' });
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
