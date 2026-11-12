import { ForgeError } from '@specforge/core';
import type { AgentProfile, AgentRole, AgentsConfig } from '@specforge/shared';
import { ClaudeAdapter } from './claude.ts';
import type { AgentAdapter } from './types.ts';

const ROLE_DEFAULTS: Record<AgentRole, Partial<AgentProfile>> = {
  analyst: { effort: 'high', maxTurns: 60 },
  reviewer: { effort: 'high', maxTurns: 40 },
};

/** 角色配置 = 内置默认值 ← 项目默认 ← 角色配置 ← 命令行覆盖 */
export function resolveProfile(role: AgentRole, config: AgentsConfig | undefined, override: Partial<AgentProfile> = {}): AgentProfile {
  const merged = { backend: 'claude', ...ROLE_DEFAULTS[role], ...config?.default, ...config?.roles?.[role] } as AgentProfile;
  for (const [k, v] of Object.entries(override)) if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
  return merged;
}

export function adapterFor(profile: AgentProfile): AgentAdapter {
  switch (profile.backend) {
    case 'claude':
      return new ClaudeAdapter();
    case 'codex':
    case 'deepseek':
      throw new ForgeError('backend_pending', `${profile.backend} 后端尚未接入（在路线图第二期后半段），请先使用 claude`);
    default:
      throw new ForgeError('bad_backend', `未知的 agent 后端：${String(profile.backend)}`);
  }
}
