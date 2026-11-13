import { useEffect, useState, type FormEvent } from 'react';
import { accessibleProjects, projectHref, validProjectId, visitedProjects, PROJECT_ROUTE_KEY, VISITED_PROJECTS_KEY } from '../project.ts';

export function ProjectPicker() {
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState<string>();
  const [projects, setProjects] = useState<string[]>([]);
  const [checking, setChecking] = useState(true);
  const destination = (entry: string) => {
    try { return projectHref(entry, sessionStorage.getItem(`${PROJECT_ROUTE_KEY}${entry}`) ?? '#/'); }
    catch { return projectHref(entry); }
  };
  useEffect(() => {
    let cancelled = false;
    let candidates: string[] = [];
    try { candidates = visitedProjects(sessionStorage.getItem(VISITED_PROJECTS_KEY)); } catch {}
    void accessibleProjects(candidates).then((entries) => {
      if (!cancelled) { setProjects(entries); setChecking(false); }
    });
    return () => { cancelled = true; };
  }, []);
  const open = (event: FormEvent) => {
    event.preventDefault();
    const selected = projectId.trim();
    if (!validProjectId(selected)) { setError('项目 ID 需为 1–64 位小写字母、数字、下划线或短横线，首位为字母或数字'); return; }
    location.assign(destination(selected));
  };
  return (
    <div className="app">
      <header className="topbar"><span className="brand">SpecForge</span></header>
      <main>
        <form className="login panel project-entry" onSubmit={open}>
          <h1>选择项目</h1>
          <p className="muted">输入管理员给出的项目 ID，或直接打开项目链接。每个项目独立登录，不提供服务器项目目录。</p>
          <label>项目 ID<input value={projectId} onChange={(event) => setProjectId(event.target.value)} autoComplete="off" required /></label>
          {error && <div className="error">{error}</div>}
          <button type="submit">打开项目</button>
        </form>
        <section className="panel project-history">
          <h2>本标签页已访问且当前可用的项目</h2>
          {checking ? <p className="muted">正在重新核对权限…</p> : projects.length ? projects.map((entry) => <a className="project-link" key={entry} href={destination(entry)}>{entry}</a>) : <p className="muted">暂无可用入口；登录失效、暂忙或不可用的项目不会列出，可使用管理员提供的链接重新进入。</p>}
        </section>
      </main>
    </div>
  );
}
