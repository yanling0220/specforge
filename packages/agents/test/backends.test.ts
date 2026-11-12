import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import {
  analystTools,
  CodexAdapter,
  compatEnv,
  emptyAnalysisDraft,
  OpenAICompatAdapter,
  resolveProfile,
  resolveProvider,
  reviewerTools,
  emptyReviewDraft,
  toolJsonSchema,
  workspaceTools,
  type AgentRunSpec,
  type ChatClient,
  type CodexThread,
  type ReviewerContext,
} from '../src/index.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sf-agents-'));
  dirs.push(d);
  return d;
}

const ctx = { acIds: ['AC-1'], decisions: [] } as unknown as ReviewerContext;

function reviewSpec(cwd: string, profile: AgentRunSpec['profile']) {
  const draft = emptyReviewDraft();
  const spec: AgentRunSpec = {
    role: 'reviewer',
    systemPrompt: 'sys',
    prompt: 'review',
    cwd,
    readOnly: true,
    profile,
    tools: reviewerTools(draft, ctx),
    toolNamespace: 'specforge',
    isComplete: () => draft.submitted,
    reset: () => Object.assign(draft, emptyReviewDraft()),
  };
  return { draft, spec };
}

describe('配置解析', () => {
  it('deepseek 后端默认走 Anthropic 兼容接口，使用 DeepSeek 的模型名', () => {
    const p = resolveProfile('analyst', { default: { backend: 'claude', model: 'claude-opus-5-5' } }, { backend: 'deepseek' });
    expect(p).toMatchObject({ backend: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-v4-pro' });
  });

  it('兼容接口的子进程环境：替换地址和 token，去掉 ANTHROPIC_API_KEY；没有 key 时报错', () => {
    const profile = { backend: 'deepseek' as const, baseUrl: 'https://x/anthropic', apiKeyEnv: 'DS_KEY' };
    const env = compatEnv(profile, { PATH: '/bin', ANTHROPIC_API_KEY: 'claude-key', DS_KEY: 'ds' })!;
    expect(env).toMatchObject({ PATH: '/bin', ANTHROPIC_BASE_URL: 'https://x/anthropic', ANTHROPIC_AUTH_TOKEN: 'ds' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(() => compatEnv(profile, {})).toThrow(/DS_KEY/);
    expect(compatEnv({ backend: 'claude' }, {})).toBeUndefined();
  });

  it('openai-compatible 预设', () => {
    process.env.SF_TEST_KEY = 'k';
    expect(resolveProvider({ backend: 'openai-compatible', provider: 'deepseek', apiKeyEnv: 'SF_TEST_KEY' })).toMatchObject({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      apiKey: 'k',
      extraBody: { thinking: { type: 'enabled' } },
    });
    expect(() => resolveProvider({ backend: 'openai-compatible', provider: 'nope' })).toThrow(/未知的 provider/);
    expect(resolveProvider({ backend: 'openai-compatible', baseUrl: 'http://h/v1', model: 'm' })).toMatchObject({ baseUrl: 'http://h/v1', model: 'm' });
  });

  it('平台工具转成 JSON Schema', () => {
    const schema = toolJsonSchema(analystTools(emptyAnalysisDraft(), { dimensions: [], existing: { questions: [] } } as never).find((t) => t.name === 'raise_question')!);
    expect(schema).toMatchObject({ type: 'object', properties: { severity: { enum: ['blocking', 'important', 'minor'] } } });
    expect((schema.required as string[]).sort()).toEqual(['category', 'question', 'severity', 'why']);
  });
});

describe('引擎自带的只读工作区工具', () => {
  it('读文件、列文件、搜索；路径不能越界，符号链接逃逸也会被拒绝', () => {
    const root = tmp();
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'src', 'a.ts'), 'const limit = 10;\nexport {};\n');
    writeFileSync(join(root, 'node_modules', 'x.ts'), 'const limit = 99;\n');
    const outside = tmp();
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    symlinkSync(outside, join(root, 'linkdir'));
    const [read, list, grep] = workspaceTools(root);

    expect(read!.handler({ path: 'src/a.ts' })).toContain('    1\tconst limit = 10;');
    expect(list!.handler({ glob: '**/*.ts' })).toBe('src/a.ts');
    expect(grep!.handler({ pattern: 'limit = \\d+' })).toBe('src/a.ts:1: const limit = 10;');
    expect(grep!.handler({ pattern: 'secret' })).toBe('（没有匹配）');
    expect(() => read!.handler({ path: '../etc/passwd' })).toThrow(/越界/);
    expect(() => read!.handler({ path: 'link.txt' })).toThrow(/越界/);
  });
});

describe('openai-compatible 适配层', () => {
  type Body = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
  const reply = (message: Record<string, unknown>): OpenAI.Chat.Completions.ChatCompletion =>
    ({ choices: [{ message, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) as never;
  const call = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

  it('跑通工具循环：工作区工具、平台工具、回传 reasoning_content、提醒未提交', async () => {
    const root = tmp();
    writeFileSync(join(root, 'a.ts'), 'x\n');
    const bodies: Body[] = [];
    const replies = [
      reply({ role: 'assistant', content: '', reasoning_content: '先看看文件', tool_calls: [call('1', 'read_file', { path: 'a.ts' }), call('2', 'Bash', { cmd: 'rm -rf /' })] }),
      reply({ role: 'assistant', content: '看完了，没问题' }),
      reply({ role: 'assistant', content: '', tool_calls: [call('3', 'submit_review', { verdict: 'pass', coverage: ['AC-1'], summary: '通过' })] }),
      reply({ role: 'assistant', content: '完成' }),
    ];
    const client: ChatClient = { create: async (b) => (bodies.push(structuredClone(b)), replies.shift()!) };
    process.env.SF_TEST_KEY = 'k';
    const { draft, spec } = reviewSpec(root, { backend: 'openai-compatible', provider: 'deepseek', apiKeyEnv: 'SF_TEST_KEY', effort: 'high' });
    const result = await new OpenAICompatAdapter(client).run(spec);

    expect(result).toMatchObject({ ok: true, turns: 4, model: 'deepseek-v4-pro', tokens: { input: 40, output: 20 } });
    expect(result.deniedTools).toEqual([{ name: 'Bash', reason: '不存在的工具' }]);
    expect(draft).toMatchObject({ submitted: true, verdict: 'pass' });
    expect(bodies[0]).toMatchObject({ model: 'deepseek-v4-pro', reasoning_effort: 'high', thinking: { type: 'enabled' } });
    expect(bodies[0]!.tools!.map((t) => (t as { function: { name: string } }).function.name)).toEqual(['read_file', 'list_files', 'grep', 'submit_review']);
    const second = bodies[1]!.messages;
    expect(second[2]).toMatchObject({ role: 'assistant', reasoning_content: '先看看文件' });
    expect(second[3]).toMatchObject({ role: 'tool', tool_call_id: '1' });
    expect(String((second[3] as { content: string }).content)).toContain('1\tx');
    expect(bodies[2]!.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('还没有') });
  });

  it('始终不提交：多次提醒后失败', async () => {
    const client: ChatClient = { create: async () => reply({ role: 'assistant', content: '我觉得没问题' }) };
    const { spec } = reviewSpec(tmp(), { backend: 'openai-compatible', baseUrl: 'http://h/v1', model: 'm' });
    const result = await new OpenAICompatAdapter(client).run(spec);
    expect(result).toMatchObject({ ok: false, turns: 3, error: 'agent 结束时没有完整提交结果' });
  });
});

describe('codex 适配层', () => {
  it('只读沙箱；提交校验失败时清空草稿并整批重交', async () => {
    const inputs: string[] = [];
    let opts: unknown;
    const submissions = [
      { calls: [{ tool: 'submit_review', args_json: JSON.stringify({ verdict: 'pass', coverage: [], summary: '通过' }) }] },
      { calls: [{ tool: 'submit_review', args_json: JSON.stringify({ verdict: 'pass', coverage: ['AC-1'], summary: '通过' }) }] },
    ];
    const thread: CodexThread = {
      run: async (input) => {
        inputs.push(input);
        return { finalResponse: JSON.stringify(submissions.shift()), usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } as never, items: [] };
      },
    };
    const { draft, spec } = reviewSpec(tmp(), { backend: 'codex', effort: 'high' });
    const result = await new CodexAdapter((o) => ((opts = o), thread)).run(spec);

    expect(opts).toMatchObject({ sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false });
    expect(result).toMatchObject({ ok: true, turns: 2, tokens: { input: 200, output: 40 } });
    expect(inputs[0]).toContain('submit_review');
    expect(inputs[1]).toMatch(/未通过引擎校验.*\n- #1 submit_review：错误：coverage 缺少：AC-1/);
    expect(draft).toMatchObject({ submitted: true, coverage: ['AC-1'] });
  });

  it('出现文件修改事件时记录为越权', async () => {
    const thread: CodexThread = {
      run: async () => ({
        finalResponse: JSON.stringify({ calls: [{ tool: 'submit_review', args_json: JSON.stringify({ verdict: 'pass', coverage: ['AC-1'], summary: 'ok' }) }] }),
        usage: null,
        items: [{ id: 'f', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }], status: 'completed' }],
      }),
    };
    const { spec } = reviewSpec(tmp(), { backend: 'codex' });
    const result = await new CodexAdapter(() => thread).run(spec);
    expect(result.deniedTools).toEqual([{ name: 'file_change', reason: '只读角色试图修改文件' }]);
  });
});
