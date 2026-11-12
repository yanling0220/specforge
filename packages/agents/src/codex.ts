import { Codex, type RunResult, type ThreadOptions } from '@openai/codex-sdk';
import { ForgeError } from '@specforge/core';
import { callPlatformTool, toolJsonSchema, type AgentAdapter, type AgentRunResult, type AgentRunSpec } from './types.ts';

// Codex 不支持进程内自定义工具，所以改用“批量提交”：
// 模型在只读沙箱里自行调查，最后用结构化输出一次性给出全部平台工具调用；
// 引擎按顺序逐条校验执行，有错误就清空草稿，把错误发回同一线程让它整批重交。

const MAX_ROUNDS = 3;

export const SUBMISSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['calls'],
  properties: {
    calls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tool', 'args_json'],
        properties: {
          tool: { type: 'string' },
          args_json: { type: 'string', description: '工具参数，JSON 对象序列化后的字符串' },
        },
      },
    },
  },
} as const;

export interface Submission {
  calls: { tool: string; args_json: string }[];
}

/** 只需要 run 方法，便于测试注入 */
export interface CodexThread {
  run(input: string, opts: { outputSchema: unknown }): Promise<Pick<RunResult, 'finalResponse' | 'usage' | 'items'>>;
}

export function submissionInstructions(spec: AgentRunSpec): string {
  const lines = spec.tools.map((t) => `- ${t.name}：${t.description.replace(/\n/g, ' ')}\n  参数 JSON Schema：${JSON.stringify(toolJsonSchema(t))}`);
  return [
    '## 提交方式',
    spec.readOnly
      ? '你在只读沙箱中运行，可以用 shell 命令（cat、ls、grep、rg 等）查看项目，但不能修改任何文件。'
      : '你可以在当前工作目录内修改文件、运行测试；不要修改 openspec/、.specforge/ 和受保护路径，越界改动会被整体丢弃。',
    '调查完成后，最终回复必须是符合输出 schema 的 JSON：calls 是按顺序执行的平台工具调用列表，',
    '每项的 args_json 是该工具参数对象的 JSON 字符串。可用的平台工具：',
    ...lines,
  ].join('\n');
}

/** 执行一批调用，返回错误列表（空表示全部成功） */
export function applySubmission(spec: AgentRunSpec, raw: string): string[] {
  let sub: Submission;
  try {
    sub = JSON.parse(raw) as Submission;
  } catch {
    return ['最终回复不是合法的 JSON'];
  }
  if (!Array.isArray(sub.calls)) return ['缺少 calls 数组'];
  const errors: string[] = [];
  sub.calls.forEach((c, i) => {
    let args: unknown;
    try {
      args = JSON.parse(c.args_json || '{}');
    } catch {
      errors.push(`#${i + 1} ${c.tool}：args_json 不是合法的 JSON`);
      return;
    }
    spec.onEvent?.({ kind: 'tool', name: c.tool, input: args });
    const out = callPlatformTool(spec.tools, c.tool, args);
    if (out.isError) errors.push(`#${i + 1} ${c.tool}：${out.text}`);
  });
  if (!errors.length && spec.isComplete && !spec.isComplete()) errors.push('调用列表不完整：缺少最终提交（例如 finish_analysis / submit_review）');
  return errors;
}

export class CodexAdapter implements AgentAdapter {
  backend = 'codex';
  private threadFactory?: (opts: ThreadOptions) => CodexThread;
  constructor(threadFactory?: (opts: ThreadOptions) => CodexThread) {
    this.threadFactory = threadFactory;
  }

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    if (!spec.readOnly && !spec.pathPolicy) throw new ForgeError('no_policy', '可写角色必须提供路径策略');
    const t0 = Date.now();
    const threadOptions: ThreadOptions = {
      model: spec.profile.model,
      workingDirectory: spec.cwd,
      // 可写角色限制在 worktree 内写入；更细的路径约束由引擎事后校验
      sandboxMode: spec.readOnly ? 'read-only' : 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      modelReasoningEffort: spec.profile.effort,
    };
    const thread =
      this.threadFactory?.(threadOptions) ??
      new Codex({
        ...(spec.profile.baseUrl ? { baseUrl: spec.profile.baseUrl } : {}),
        ...(spec.profile.apiKeyEnv ? { apiKey: process.env[spec.profile.apiKeyEnv] } : {}),
      }).startThread(threadOptions);

    const result: AgentRunResult = {
      ok: false,
      backend: this.backend,
      model: spec.profile.model,
      turns: 0,
      costUsd: 0,
      tokens: { input: 0, output: 0 },
      durationMs: 0,
      deniedTools: [],
    };
    let input = `${spec.systemPrompt}\n\n${spec.prompt}\n\n${submissionInstructions(spec)}`;
    try {
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        const turn = await thread.run(input, { outputSchema: SUBMISSION_SCHEMA });
        result.turns++;
        result.tokens!.input += turn.usage?.input_tokens ?? 0;
        result.tokens!.output += turn.usage?.output_tokens ?? 0;
        for (const item of turn.items) {
          if (item.type === 'file_change' && spec.readOnly) {
            // 只读沙箱下不应出现；出现即视为越权，事后工作区校验也会兜底
            result.deniedTools.push({ name: 'file_change', reason: '只读角色试图修改文件' });
            spec.onEvent?.({ kind: 'denied', name: 'file_change', reason: '只读角色试图修改文件' });
          }
        }
        spec.reset?.();
        const errors = applySubmission(spec, turn.finalResponse);
        if (!errors.length) {
          result.ok = true;
          break;
        }
        result.error = errors.join('；');
        input = `你的提交未通过引擎校验，草稿已清空。请修正以下问题后，重新提交完整的调用列表：\n${errors.map((e) => `- ${e}`).join('\n')}`;
      }
    } catch (e) {
      result.error = (e as Error).message;
    }
    if (result.ok) result.error = undefined;
    result.durationMs = Date.now() - t0;
    return result;
  }
}
