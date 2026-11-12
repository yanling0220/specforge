// 路径策略与防作弊扫描（纯函数，输入 git diff 结果）。

/** 把 glob 转成正则：** 匹配任意层级，* 匹配单层 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

export interface PathPolicy {
  writable: string[];
  forbidden: string[];
}

export interface PolicyViolation {
  path: string;
  reason: string;
}

/** 事后校验：agent 一轮执行后改动的文件是否越界 */
export function checkPathPolicy(changedFiles: string[], policy: PathPolicy): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  for (const path of changedFiles) {
    if (matchesAny(path, policy.forbidden)) out.push({ path, reason: '命中禁止路径' });
    else if (!matchesAny(path, policy.writable)) out.push({ path, reason: '不在本阶段可写范围内' });
  }
  return out;
}

export interface AddedLine {
  file: string;
  line: string;
}

/** 从 unified diff 中提取新增的行 */
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '');
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      out.push({ file, line: line.slice(1) });
    }
  }
  return out;
}

export interface SkipHit {
  file: string;
  line: string;
  pattern: string;
}

export function findAddedSkips(diff: string, patterns: string[], testGlobs: string[]): SkipHit[] {
  const regs = patterns.map((p) => ({ p, re: new RegExp(p) }));
  return addedLines(diff)
    .filter((a) => matchesAny(a.file, testGlobs))
    .flatMap((a) => regs.filter(({ re }) => re.test(a.line)).map(({ p }) => ({ file: a.file, line: a.line.trim(), pattern: p })));
}

/** 实现阶段的路径策略：默认可写全部，禁止 spec / 平台状态 / git 内部 / 受保护路径 */
export function implementPolicy(protectedPaths: string[], writable: string[] = ['**']): PathPolicy {
  return { writable, forbidden: [...new Set(['openspec/**', '.specforge/**', '.git/**', ...protectedPaths])] };
}
