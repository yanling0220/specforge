import { createSdkMcpServer, query, tool, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { ForgeError } from '@specforge/core';
import type { AgentAdapter, AgentRunResult, AgentRunSpec, PlatformTool } from './types.ts';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

/** 只读角色可用的内置工具 */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

/**
 * 工具层拦截（设计文档 5 ②）：只放行白名单里的工具。
 * 内置工具集已经通过 `tools` 选项收窄，这里再兜一层，防止配置或 SDK 行为变化导致越权。
 */
export function makeCanUseTool(spec: Pick<AgentRunSpec, 'readOnly' | 'toolNamespace' | 'tools'>, onDenied: (name: string, reason: string) => void): CanUseTool {
  const platform = new Set(spec.tools.map((t) => `mcp__${spec.toolNamespace}__${t.name}`));
  const builtins = new Set(spec.readOnly ? READ_ONLY_TOOLS : []);
  return async (toolName) => {
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

export class ClaudeAdapter implements AgentAdapter {
  backend = 'claude';

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    if (!spec.readOnly) throw new ForgeError('not_supported', '可写角色将在实现阶段（G5）接入，当前只支持只读角色');
    const t0 = Date.now();
    const model = spec.profile.model ?? DEFAULT_CLAUDE_MODEL;
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
        tools: spec.readOnly ? READ_ONLY_TOOLS : [],
        mcpServers: { [spec.toolNamespace]: server },
        canUseTool: makeCanUseTool(spec, onDenied),
        permissionMode: 'default',
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
        result.costUsd = msg.total_cost_usd;
        result.sessionId = msg.session_id;
        if (msg.subtype === 'success' && !msg.is_error) result.ok = true;
        else result.error = msg.subtype === 'success' ? '运行以错误结束' : msg.subtype;
      }
    }
    result.durationMs = Date.now() - t0;
    return result;
  }
}
