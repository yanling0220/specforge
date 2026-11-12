import { checkPathPolicy, type PathPolicy } from '@specforge/core';
import { relative as relativePath, resolve as resolvePath, sep as sepChar } from 'node:path';
import type { AgentProfile, AgentRole } from '@specforge/shared';
import { z as zImpl, type z } from 'zod';

/**
 * 平台工具：与后端无关的定义。各适配层负责把它包装成自己的工具格式
 * （Claude 用进程内 MCP server；Codex / DeepSeek 后续接入）。
 * 处理函数只往草稿里累积数据，真正落盘由引擎在运行结束后完成。
 */
export interface PlatformTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  shape: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>) => string;
}

export interface AgentRunSpec {
  role: AgentRole;
  systemPrompt: string;
  prompt: string;
  /** agent 的工作目录（目标项目根目录） */
  cwd: string;
  /** 只读角色：不允许任何写文件或执行命令的工具 */
  readOnly: boolean;
  /** 可写角色的路径策略（相对 cwd）；执行时拦截，引擎事后还会再校验一次 */
  pathPolicy?: PathPolicy;
  profile: AgentProfile;
  tools: PlatformTool[];
  /** 平台工具在后端中的命名空间 */
  toolNamespace: string;
  onEvent?: (e: AgentEvent) => void;
  /** 角色的产出是否已经完整提交（例如调用了 finish_analysis）；用于提醒或重试 */
  isComplete?: () => boolean;
  /** 清空草稿；需要整批重交的后端（codex）在重试前调用 */
  reset?: () => void;
}

export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: unknown }
  | { kind: 'denied'; name: string; reason: string };

export interface AgentRunResult {
  ok: boolean;
  error?: string;
  backend: string;
  model?: string;
  sessionId?: string;
  turns: number;
  /** 后端报告的费用估算；拿不到时为 0，此时看 tokens */
  costUsd: number;
  tokens?: { input: number; output: number };
  durationMs: number;
  deniedTools: { name: string; reason: string }[];
}

export interface AgentAdapter {
  backend: string;
  run(spec: AgentRunSpec): Promise<AgentRunResult>;
}

/** 逐个推断工具参数类型，再擦除为通用的 PlatformTool */
export function defineTool<Shape extends z.ZodRawShape>(t: PlatformTool<Shape>): PlatformTool {
  return t as unknown as PlatformTool;
}

/** 按名称执行平台工具：校验参数并调用处理函数。错误以文本返回，交给模型修正 */
export function callPlatformTool(tools: PlatformTool[], name: string, rawArgs: unknown): { text: string; isError: boolean } {
  const t = tools.find((x) => x.name === name);
  if (!t) return { text: `错误：没有名为 ${name} 的工具`, isError: true };
  const parsed = zodObject(t).safeParse(rawArgs ?? {});
  if (!parsed.success) return { text: `参数错误：${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('；')}`, isError: true };
  try {
    return { text: t.handler(parsed.data as never), isError: false };
  } catch (e) {
    return { text: `错误：${(e as Error).message}`, isError: true };
  }
}

export function zodObject(t: PlatformTool) {
  return zImpl.object(t.shape);
}

/** 工具参数的 JSON Schema（给 OpenAI 兼容接口用） */
export function toolJsonSchema(t: PlatformTool): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = zImpl.toJSONSchema(zodObject(t), { io: 'input' }) as Record<string, unknown>;
  return schema;
}

/** 可写角色检查目标路径：必须在 cwd 内，且符合路径策略。返回拒绝原因，允许时返回 undefined */
export function writeDenial(cwd: string, filePath: string, policy: PathPolicy | undefined): string | undefined {
  const root = resolvePath(cwd);
  const abs = resolvePath(root, filePath);
  if (abs !== root && !abs.startsWith(root + sepChar)) return `路径在工作目录之外：${filePath}`;
  const rel = relativePath(root, abs).split(sepChar).join('/');
  if (!policy) return '没有配置路径策略';
  const [violation] = checkPathPolicy([rel], policy);
  return violation ? `${rel}：${violation.reason}` : undefined;
}
