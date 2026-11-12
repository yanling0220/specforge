import OpenAI from 'openai';
import { ForgeError } from '@specforge/core';
import type { AgentProfile } from '@specforge/shared';
import { callPlatformTool, toolJsonSchema, type AgentAdapter, type AgentRunResult, type AgentRunSpec, type PlatformTool } from './types.ts';
import { workspaceTools, writableWorkspaceTools } from './workspace-tools.ts';

// 引擎自带的最小 agent 循环，适用于任何 OpenAI 兼容的 Chat Completions 接口。
// 模型能用的工具只有引擎提供的：只读工作区工具 + 本角色的平台工具，因此天然无法写文件或执行命令。

export interface ProviderPreset {
  baseUrl: string;
  apiKeyEnv?: string;
  model: string;
  /** 额外请求体字段（例如 DeepSeek 的思考模式开关） */
  extraBody?: Record<string, unknown>;
  /** 是否传 reasoning_effort */
  supportsEffort: boolean;
}

export const PROVIDERS: Record<string, ProviderPreset> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    model: 'deepseek-v4-pro',
    extraBody: { thinking: { type: 'enabled' } },
    supportsEffort: true,
  },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3-coder', supportsEffort: false },
};

const MAX_NUDGES = 2;
const MAX_TOOL_RESULT_CHARS = 60_000;

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** DeepSeek 等思考模型：带工具的多轮对话必须回传每轮的 reasoning_content */
type AssistantWithReasoning = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & { reasoning_content?: string };

/** 只需要 create 方法，便于测试注入 */
export interface ChatClient {
  create(body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming): Promise<OpenAI.Chat.Completions.ChatCompletion>;
}

export function resolveProvider(profile: AgentProfile): ProviderPreset & { apiKey?: string } {
  const preset = profile.provider ? PROVIDERS[profile.provider] : undefined;
  if (profile.provider && !preset && !profile.baseUrl) {
    throw new ForgeError('bad_provider', `未知的 provider「${profile.provider}」，可用：${Object.keys(PROVIDERS).join(', ')}，或直接配置 baseUrl`);
  }
  const baseUrl = profile.baseUrl ?? preset?.baseUrl;
  if (!baseUrl) throw new ForgeError('no_base_url', 'openai-compatible 后端需要配置 provider 或 baseUrl');
  const apiKeyEnv = profile.apiKeyEnv ?? preset?.apiKeyEnv;
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  if (apiKeyEnv && !apiKey) throw new ForgeError('no_api_key', `需要 API key：请设置环境变量 ${apiKeyEnv}`);
  const model = profile.model ?? preset?.model;
  if (!model) throw new ForgeError('no_model', 'openai-compatible 后端需要配置 model');
  return { baseUrl, apiKeyEnv, apiKey, model, extraBody: preset?.extraBody, supportsEffort: preset?.supportsEffort ?? false };
}

function toOpenAiTool(t: PlatformTool): OpenAI.Chat.Completions.ChatCompletionTool {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: toolJsonSchema(t) } };
}

export class OpenAICompatAdapter implements AgentAdapter {
  backend = 'openai-compatible';
  private client?: ChatClient;
  constructor(client?: ChatClient) {
    this.client = client;
  }

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    if (!spec.readOnly && !spec.pathPolicy) throw new ForgeError('no_policy', '可写角色必须提供路径策略');
    const t0 = Date.now();
    const provider = resolveProvider(spec.profile);
    const client: ChatClient =
      this.client ?? new OpenAI({ baseURL: provider.baseUrl, apiKey: provider.apiKey ?? 'not-needed' }).chat.completions;

    const builtins = [...workspaceTools(spec.cwd), ...(spec.readOnly ? [] : writableWorkspaceTools(spec.cwd, spec.pathPolicy!))];
    const all = [...builtins, ...spec.tools];
    const tools = all.map(toOpenAiTool);
    const messages: Message[] = [
      { role: 'system', content: spec.systemPrompt },
      {
        role: 'user',
        content:
          spec.prompt +
          (spec.readOnly
            ? '\n\n（可用 read_file / list_files / grep 查看项目文件；结论只能通过平台工具提交。）'
            : '\n\n（可用 read_file / list_files / grep 查看，write_file / replace_in_file 修改，run_command 运行测试；完成后通过平台工具提交。）'),
      },
    ];
    const result: AgentRunResult = {
      ok: false,
      backend: this.backend,
      model: provider.model,
      turns: 0,
      costUsd: 0,
      tokens: { input: 0, output: 0 },
      durationMs: 0,
      deniedTools: [],
    };
    const maxTurns = spec.profile.maxTurns ?? 60;
    let nudges = 0;

    try {
      while (result.turns < maxTurns) {
        result.turns++;
        const effort = spec.profile.effort;
        const body = {
          model: provider.model,
          messages,
          tools,
          tool_choice: 'auto' as const,
          ...(provider.supportsEffort && effort ? { reasoning_effort: effort } : {}),
          ...provider.extraBody,
        };
        const res = await client.create(body);
        result.tokens!.input += res.usage?.prompt_tokens ?? 0;
        result.tokens!.output += res.usage?.completion_tokens ?? 0;
        const choice = res.choices[0];
        if (!choice) throw new Error('接口没有返回结果');
        const msg = choice.message as typeof choice.message & { reasoning_content?: string };

        const assistant: AssistantWithReasoning = { role: 'assistant', content: msg.content ?? '' };
        if (msg.reasoning_content) assistant.reasoning_content = msg.reasoning_content;
        const calls = (msg.tool_calls ?? []).filter((c) => c.type === 'function');
        if (calls.length) assistant.tool_calls = calls;
        messages.push(assistant);
        if (msg.content?.trim()) spec.onEvent?.({ kind: 'text', text: msg.content });

        if (!calls.length) {
          if (!spec.isComplete || spec.isComplete()) break;
          if (nudges++ >= MAX_NUDGES) break;
          messages.push({ role: 'user', content: '你还没有通过平台工具完整提交结果。请调用相应的工具完成提交。' });
          continue;
        }

        for (const call of calls) {
          const name = call.function.name;
          let args: unknown;
          let out: { text: string; isError: boolean };
          try {
            args = JSON.parse(call.function.arguments || '{}');
            spec.onEvent?.({ kind: 'tool', name, input: args });
            out = callPlatformTool(all, name, args);
          } catch {
            out = { text: '参数不是合法的 JSON，请重新调用', isError: true };
          }
          if (out.isError && !all.some((t) => t.name === name)) {
            result.deniedTools.push({ name, reason: '不存在的工具' });
            spec.onEvent?.({ kind: 'denied', name, reason: '不存在的工具' });
          }
          const text = out.text.length > MAX_TOOL_RESULT_CHARS ? out.text.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…（已截断）' : out.text;
          messages.push({ role: 'tool', tool_call_id: call.id, content: text });
        }
      }
      result.ok = !spec.isComplete || spec.isComplete();
      if (!result.ok) result.error = result.turns >= maxTurns ? `达到最大轮数 ${maxTurns}` : 'agent 结束时没有完整提交结果';
    } catch (e) {
      result.error = e instanceof OpenAI.APIError ? `接口错误 ${e.status ?? ''}：${e.message}` : (e as Error).message;
    }
    result.durationMs = Date.now() - t0;
    return result;
  }
}
