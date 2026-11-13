import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ForgeError } from '@specforge/core';
import { git } from '@specforge/runner';
import { Store } from '@specforge/store';

export interface ProjectRegistration {
  id: string;
  root: string;
}

export interface RegisteredProject {
  id: string;
  store: Store;
  check(): void;
}

function checkTree(path: string): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return;
  if (entry.isSymbolicLink()) throw new ForgeError('project_unavailable', '项目状态与产物不能使用符号链接');
  if (entry.isDirectory()) {
    for (const child of readdirSync(path, { withFileTypes: true })) {
      if (child.isSymbolicLink()) throw new ForgeError('project_unavailable', '项目状态与产物不能使用符号链接');
      if (child.isDirectory()) checkTree(join(path, child.name));
    }
  }
}

export function readProjects(file: string): ProjectRegistration[] {
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    if (config?.version !== 1 || !Array.isArray(config.projects)) throw new Error();
    return config.projects.map((entry: ProjectRegistration) => {
      if (!entry || typeof entry.root !== 'string') throw new Error();
      return { id: entry.id, root: resolve(dirname(resolve(file)), entry.root) };
    });
  } catch {
    throw new ForgeError('bad_arg', '项目配置必须是 version=1 且包含 projects 数组的 JSON');
  }
}

export function registerProjects(entries: ProjectRegistration[]): RegisteredProject[] {
  if (!Array.isArray(entries) || !entries.length) throw new ForgeError('bad_arg', '至少需要登记一个项目');
  const ids = new Set<string>();
  const roots = new Set<string>();
  const commonDirs = new Set<string>();
  return entries.map((entry) => {
    if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.id) || ids.has(entry.id)) {
      throw new ForgeError('bad_arg', '项目 ID 必须唯一且由小写字母、数字、下划线或短横线组成（1–64 位）');
    }
    if (typeof entry.root !== 'string' || !isAbsolute(entry.root)) throw new ForgeError('bad_arg', '项目 root 必须是绝对路径');
    let root: string;
    let commonDir: string;
    try {
      root = realpathSync(entry.root);
      if (realpathSync(git(root, ['rev-parse', '--show-toplevel'])) !== root) throw new Error();
      commonDir = realpathSync(resolve(root, git(root, ['rev-parse', '--git-common-dir'])));
      if (realpathSync(join(root, '.specforge')) !== join(root, '.specforge')) throw new Error();
      if (realpathSync(join(root, '.specforge', 'config.json')) !== join(root, '.specforge', 'config.json')) throw new Error();
      if (!statSync(join(root, '.specforge', 'config.json')).isFile()) throw new Error();
      checkTree(join(root, '.specforge'));
      checkTree(join(root, 'openspec'));
    } catch {
      throw new ForgeError('bad_arg', `项目 ${entry.id} 必须指向已初始化的独立 Git 仓库根目录`);
    }
    if (roots.has(root) || commonDirs.has(commonDir)) throw new ForgeError('bad_arg', '不能重复接入同一仓库或共享 Git 元数据的 worktree');
    ids.add(entry.id);
    roots.add(root);
    commonDirs.add(commonDir);
    const identity = statSync(root);
    const gitIdentity = statSync(join(root, '.git'));
    const gitPath = realpathSync(join(root, '.git'));
    const gitFile = gitIdentity.isFile() ? readFileSync(gitPath, 'utf8') : undefined;
    return {
      id: entry.id,
      store: new Store(root),
      check() {
        const current = statSync(root);
        const currentGit = statSync(join(root, '.git'));
        if (realpathSync(root) !== root || current.dev !== identity.dev || current.ino !== identity.ino || currentGit.dev !== gitIdentity.dev || currentGit.ino !== gitIdentity.ino || realpathSync(join(root, '.git')) !== gitPath || (gitFile !== undefined && readFileSync(gitPath, 'utf8') !== gitFile) || realpathSync(join(root, '.specforge')) !== join(root, '.specforge') || realpathSync(join(root, '.specforge', 'config.json')) !== join(root, '.specforge', 'config.json')) {
          throw new ForgeError('project_unavailable', '登记的仓库已改变，请联系管理员');
        }
        checkTree(join(root, '.specforge'));
        checkTree(join(root, 'openspec'));
      },
    };
  });
}
