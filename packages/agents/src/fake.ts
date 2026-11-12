import type { AgentAdapter, AgentRunResult, AgentRunSpec } from './types.ts';

/** 测试用后端：按脚本依次调用平台工具，不访问任何模型 */
export class ScriptedAdapter implements AgentAdapter {
  backend = 'scripted';
  calls: { tool: string; result: string; isError: boolean }[] = [];
  script: { tool: string; args: Record<string, unknown> }[];
  constructor(script: { tool: string; args: Record<string, unknown> }[]) {
    this.script = script;
  }

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    for (const step of this.script) {
      const t = spec.tools.find((x) => x.name === step.tool);
      if (!t) throw new Error(`脚本引用了未提供的工具 ${step.tool}`);
      const { z } = await import('zod');
      try {
        const args = z.object(t.shape).parse(step.args);
        this.calls.push({ tool: step.tool, result: t.handler(args), isError: false });
      } catch (e) {
        this.calls.push({ tool: step.tool, result: (e as Error).message, isError: true });
      }
    }
    return { ok: true, backend: this.backend, turns: this.script.length, costUsd: 0, durationMs: 0, deniedTools: [] };
  }
}
