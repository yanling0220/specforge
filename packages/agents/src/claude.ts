import { createSdkMcpServer, query, tool, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { ForgeError } from '@specforge/core';
import type { AgentProfile } from '@specforge/shared';
import { writeDenial, type AgentAdapter, type AgentRunResult, type AgentRunSpec, type PlatformTool } from './types.ts';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

/** 只读角色可用的内置工具 */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];
/** 可写角色可用的内置工具；写文件类工具逐次检查路径 */
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit'];
export const WRITABLE_TOOLS = [...READ_ONLY_TOOLS, ...WRITE_TOOLS, 'Bash'];

/**
 * 工具层拦截（设计文档 5 ②）：只放行白名单里的工具。
 * 内置工具集已经通过 `tools` 选项收窄，这里再兜一层，防止配置或 SDK 行为变化导致越权。
 */
export function makeCanUseTool(
  spec: Pick<AgentRunSpec, 'readOnly' | 'toolNamespace' | 'tools' | 'cwd' | 'pathPolicy'>,
  onDenied: (name: string, reason: string) => void,
): CanUseTool {
  const platform = new Set(spec.tools.map((t) => `mcp__${spec.toolNamespace}__${t.name}`));
  const builtins = new Set(spec.readOnly ? READ_ONLY_TOOLS : WRITABLE_TOOLS);
  return async (toolName, input) => {
    if (!spec.readOnly && WRITE_TOOLS.includes(toolName)) {
      const target = typeof input.file_path === 'string' ? input.file_path : '';
      const denial = target ? writeDenial(spec.cwd, target, spec.pathPolicy) : '缺少 file_path';
      if (denial) {
        onDenied(toolName, denial);
        return { behavior: 'deny', message: `不允许写入：${denial}` };
      }
      return { behavior: 'allow' };
    }
    if (platform.has(toolName) || builtins.has(toolName)) return { behavior: 'allow' };
    const reason = spec.readOnly ? `只读角色不允许使用 ${toolName}` : `${toolName} 不在本阶段允许的工具中`;
    onDenied(toolName, reason);
    return { behavior: 'deny', message: reason };
  };
}

function toSdkTool(t: PlatformTool) {
  return tool(t.name, t.description, t.shape, async (args) => {
    try {
      return { content: [{ type: 'text' as const, text: t.handler(args as never) }] };
    } catch (e) {
      // 校验失败返回给模型，让它修正后重试
      return { content: [{ type: 'text' as const, text: `错误：${(e as Error).message}` }], isError: true };
    }
  });
}

/**
 * 指向 Anthropic 兼容接口（如 DeepSeek）时的子进程环境。
 * SDK 的 env 选项会整体替换子进程环境，所以在 process.env 基础上修改；
 * 去掉 ANTHROPIC_API_KEY，避免它优先于 AUTH_TOKEN 把请求发到错误的服务。
 */
export function compatEnv(profile: AgentProfile, source: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  if (!profile.baseUrl) return undefined;
  const keyVar = profile.apiKeyEnv;
  const key = keyVar ? source[keyVar] : undefined;
  if (!keyVar || !key) {
    throw new ForgeError('no_api_key', `${profile.backend} 后端需要 API key：请设置环境变量 ${keyVar ?? '(未配置 apiKeyEnv)'}`);
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && k !== 'ANTHROPIC_API_KEY') env[k] = v;
  env.ANTHROPIC_BASE_URL = profile.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = key;
  return env;
}

export class ClaudeAdapter implements AgentAdapter {
  backend: string;
  constructor(backend = 'claude') {
    this.backend = backend;
  }

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    if (!spec.readOnly && !spec.pathPolicy) throw new ForgeError('no_policy', '可写角色必须提供路径策略');
    const t0 = Date.now();
    const model = spec.profile.model ?? DEFAULT_CLAUDE_MODEL;
    const env = compatEnv(spec.profile);
    const deniedTools: AgentRunResult['deniedTools'] = [];
    const onDenied = (name: string, reason: string) => {
      deniedTools.push({ name, reason });
      spec.onEvent?.({ kind: 'denied', name, reason });
    };
    const server = createSdkMcpServer({ name: spec.toolNamespace, version: '0.1.0', tools: spec.tools.map(toSdkTool) });

    const result: AgentRunResult = { ok: false, backend: this.backend, model, turns: 0, costUsd: 0, durationMs: 0, deniedTools };
    const stream = query({
      prompt: spec.prompt,
      options: {
        cwd: spec.cwd,
        model,
        effort: spec.profile.effort ?? 'high',
        maxTurns: spec.profile.maxTurns ?? 60,
        maxBudgetUsd: spec.profile.maxBudgetUsd,
        systemPrompt: spec.systemPrompt,
        // 不加载用户 / 项目的 Claude 设置，避免其中的权限放行规则绕过引擎（项目约定由引擎写进 prompt）
        settingSources: [],
        tools: spec.readOnly ? READ_ONLY_TOOLS : WRITABLE_TOOLS,
        mcpServers: { [spec.toolNamespace]: server },
        canUseTool: makeCanUseTool(spec, onDenied),
        permissionMode: 'default',
        ...(env ? { env } : {}),
      },
    });

    for await (const msg of stream) {
      if (msg.type === 'assistant') {
        result.sessionId = msg.session_id;
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text.trim()) spec.onEvent?.({ kind: 'text', text: block.text });
          if (block.type === 'tool_use') spec.onEvent?.({ kind: 'tool', name: block.name, input: block.input });
        }
      } else if (msg.type === 'result') {
        result.turns = msg.num_turns;
        // 走兼容接口时，SDK 按 Claude 价格估算的费用不准确，只报告 token 数
        result.costUsd = env ? 0 : msg.total_cost_usd;
        result.sessionId = msg.session_id;
        result.tokens = { input: msg.usage.input_tokens, output: msg.usage.output_tokens };
        if (msg.subtype === 'success' && !msg.is_error) result.ok = !spec.isComplete || spec.isComplete();
        if (result.ok === false && msg.subtype === 'success' && !msg.is_error) result.error = 'agent 结束时没有完整提交结果';
        else if (msg.subtype !== 'success' || msg.is_error) result.error = msg.subtype === 'success' ? '运行以错误结束' : msg.subtype;
      }
    }
    result.durationMs = Date.now() - t0;
    return result;
  }
}
