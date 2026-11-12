import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { globToRegExp } from '@specforge/core';
import { defineTool, type PlatformTool } from './types.ts';

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
