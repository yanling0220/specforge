import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { globToRegExp, type PathPolicy } from '@specforge/core';
import { defineTool, writeDenial, type PlatformTool } from './types.ts';

// 引擎自己实现的只读工具，给没有内置文件工具的后端（openai-compatible）使用。
// 所有路径都限制在项目目录内，且不读 .git 与依赖目录。

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', 'target', '.next']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_LINES = 2000;
const MAX_LIST = 500;
const MAX_MATCHES = 200;

/** 把相对路径解析到项目内；越界（含符号链接逃逸）则抛错 */
export function resolveInside(root: string, path: string): string {
  const realRoot = realpathSync(root);
  const abs = resolve(realRoot, path);
  const real = existsSync(abs) ? realpathSync(abs) : abs;
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error(`路径越界：${path}`);
  return real;
}

function walk(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (out.length >= MAX_LIST * 20) return;
    const abs = join(dir, name);
    // 不跟随符号链接，防止通过链接遍历到项目外
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(root, abs, out);
    } else if (st.isFile()) {
      out.push(relative(root, abs).split(sep).join('/'));
    }
  }
}

function listFiles(root: string, glob?: string): string[] {
  const all: string[] = [];
  const real = realpathSync(root);
  walk(real, real, all);
  return glob ? all.filter((f) => globToRegExp(glob).test(f)) : all;
}

function isText(buf: Buffer): boolean {
  return !buf.subarray(0, 8000).includes(0);
}

export function workspaceTools(root: string): PlatformTool[] {
  return [
    defineTool({
      name: 'read_file',
      description: '读取项目内的文本文件，返回带行号的内容。大文件用 offset / limit 分段读取。',
      shape: { path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(MAX_READ_LINES).optional() },
      handler: ({ path, offset = 1, limit = MAX_READ_LINES }) => {
        const abs = resolveInside(root, path);
        const st = statSync(abs, { throwIfNoEntry: false });
        if (!st?.isFile()) throw new Error(`文件不存在：${path}`);
        if (st.size > MAX_FILE_BYTES * 5) throw new Error(`文件过大（${st.size} 字节）`);
        const buf = readFileSync(abs);
        if (!isText(buf)) throw new Error('二进制文件，无法读取');
        const lines = buf.toString('utf8').split('\n');
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const body = slice.map((l, i) => `${String(offset + i).padStart(5)}\t${l}`).join('\n');
        const rest = lines.length - (offset - 1 + slice.length);
        return rest > 0 ? `${body}\n…（还有 ${rest} 行，用 offset=${offset + slice.length} 继续）` : body;
      },
    }),
    defineTool({
      name: 'list_files',
      description: '列出项目内的文件（跳过 .git、node_modules 等）。glob 支持 * 和 **，例如 src/**/*.ts。',
      shape: { glob: z.string().optional() },
      handler: ({ glob }) => {
        const files = listFiles(root, glob);
        const shown = files.slice(0, MAX_LIST);
        return shown.length
          ? shown.join('\n') + (files.length > MAX_LIST ? `\n…（共 ${files.length} 个，请缩小 glob）` : '')
          : '（没有匹配的文件）';
      },
    }),
    defineTool({
      name: 'grep',
      description: '在项目文件中按正则搜索，返回 文件:行号: 内容。可用 glob 限定文件范围。',
      shape: { pattern: z.string().min(1), glob: z.string().optional(), ignoreCase: z.boolean().optional() },
      handler: ({ pattern, glob, ignoreCase }) => {
        let re: RegExp;
        try {
          re = new RegExp(pattern, ignoreCase ? 'i' : '');
        } catch (e) {
          throw new Error(`正则无效：${(e as Error).message}`);
        }
        const hits: string[] = [];
        for (const f of listFiles(root, glob)) {
          const abs = join(realpathSync(root), f);
          if (statSync(abs).size > MAX_FILE_BYTES) continue;
          const buf = readFileSync(abs);
          if (!isText(buf)) continue;
          buf.toString('utf8').split('\n').forEach((line, i) => {
            if (hits.length < MAX_MATCHES && re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 300)}`);
          });
          if (hits.length >= MAX_MATCHES) break;
        }
        return hits.length ? hits.join('\n') + (hits.length >= MAX_MATCHES ? '\n…（结果过多已截断）' : '') : '（没有匹配）';
      },
    }),
  ];
}

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_TAIL = 20_000;

/** 可写角色的工具：写文件 / 替换片段受路径策略约束；命令在 cwd 内执行（越界写入由引擎事后校验兜底） */
export function writableWorkspaceTools(root: string, policy: PathPolicy): PlatformTool[] {
  const target = (path: string) => {
    const denial = writeDenial(realpathSync(root), path, policy);
    if (denial) throw new Error(`不允许写入：${denial}`);
    return join(realpathSync(root), path);
  };
  return [
    defineTool({
      name: 'write_file',
      description: '创建或覆盖项目内的文件（整文件内容）。不能写 openspec/、.specforge/ 和受保护路径。',
      shape: { path: z.string(), content: z.string() },
      handler: ({ path, content }) => {
        const abs = target(path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
        return `已写入 ${path}（${content.split('\n').length} 行）`;
      },
    }),
    defineTool({
      name: 'replace_in_file',
      description: '把文件中唯一出现的 old 片段替换为 new。old 必须在文件中恰好出现一次。',
      shape: { path: z.string(), old: z.string().min(1), new: z.string() },
      handler: ({ path, old, new: replacement }) => {
        const abs = target(path);
        if (!existsSync(abs)) throw new Error(`文件不存在：${path}`);
        const text = readFileSync(abs, 'utf8');
        const count = text.split(old).length - 1;
        if (count !== 1) throw new Error(`old 片段出现了 ${count} 次，必须恰好 1 次`);
        writeFileSync(abs, text.replace(old, () => replacement));
        return `已修改 ${path}`;
      },
    }),
    defineTool({
      name: 'run_command',
      description: '在项目根目录执行 shell 命令（例如运行测试），返回退出码和输出末尾。超时 10 分钟。',
      shape: { command: z.string().min(1) },
      handler: ({ command }) => {
        const res = spawnSync('sh', ['-c', command], { cwd: root, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: '1' } });
        const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
        const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
        return `退出码 ${timedOut ? '超时' : res.status}\n${out.slice(-COMMAND_TAIL)}`;
      },
    }),
  ];
}
