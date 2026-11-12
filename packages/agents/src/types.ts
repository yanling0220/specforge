import type { AgentProfile, AgentRole } from '@specforge/shared';
import type { z } from 'zod';

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
  profile: AgentProfile;
  tools: PlatformTool[];
  /** 平台工具在后端中的命名空间 */
  toolNamespace: string;
  onEvent?: (e: AgentEvent) => void;
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
  costUsd: number;
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
