import { ForgeError } from '@specforge/core';
import type { AgentProfile, AgentRole, AgentsConfig } from '@specforge/shared';
import { ClaudeAdapter } from './claude.ts';
import { CodexAdapter } from './codex.ts';
import { OpenAICompatAdapter } from './openai-compat.ts';
import type { AgentAdapter } from './types.ts';

const ROLE_DEFAULTS: Record<AgentRole, Partial<AgentProfile>> = {
  analyst: { effort: 'high', maxTurns: 60 },
  reviewer: { effort: 'high', maxTurns: 40 },
  implementer: { effort: 'high', maxTurns: 120 },
  'spec-writer': { effort: 'high', maxTurns: 40 },
  architect: { effort: 'high', maxTurns: 60 },
  planner: { effort: 'high', maxTurns: 30 },
};

/** 各后端的默认连接参数；用户配置优先 */
const BACKEND_DEFAULTS: Partial<Record<AgentProfile['backend'], Partial<AgentProfile>>> = {
  // DeepSeek 的 Anthropic 兼容接口，运行在 Claude Agent SDK 上
  deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-v4-pro' },
};

export const BACKENDS: AgentProfile['backend'][] = ['claude', 'deepseek', 'codex', 'openai-compatible'];

/** 角色配置 = 内置默认值 ← 项目默认 ← 角色配置 ← 命令行覆盖；最后补上后端默认连接参数 */
export function resolveProfile(role: AgentRole, config: AgentsConfig | undefined, override: Partial<AgentProfile> = {}): AgentProfile {
  const merged = { backend: 'claude', ...ROLE_DEFAULTS[role], ...config?.default, ...config?.roles?.[role] } as AgentProfile;
  for (const [k, v] of Object.entries(override)) if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
  // 切换了后端，但模型还是别的后端的名字时，用新后端的默认模型
  if (override.backend && !override.model && config?.default?.backend !== override.backend && config?.roles?.[role]?.backend !== override.backend) {
    delete merged.model;
  }
  for (const [k, v] of Object.entries(BACKEND_DEFAULTS[merged.backend] ?? {})) {
    const key = k as keyof AgentProfile;
    if (merged[key] === undefined) (merged as unknown as Record<string, unknown>)[key] = v;
  }
  return merged;
}

export function adapterFor(profile: AgentProfile): AgentAdapter {
  switch (profile.backend) {
    case 'claude':
      return new ClaudeAdapter('claude');
    case 'deepseek':
      return new ClaudeAdapter('deepseek');
    case 'codex':
      return new CodexAdapter();
    case 'openai-compatible':
      return new OpenAICompatAdapter();
    default:
      throw new ForgeError('bad_backend', `未知的 agent 后端：${String(profile.backend)}，可用：${BACKENDS.join(', ')}`);
  }
}
