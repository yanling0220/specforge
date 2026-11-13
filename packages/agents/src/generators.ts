import { z } from 'zod';
import type { AgentRole } from '@specforge/shared';
import { RAISE_QUESTION_RULE, raiseQuestionTool, type RaiseContext, type RaisedQuestion } from './raise-question.ts';
import { defineTool, type PlatformTool } from './types.ts';

// 生成类 agent（T2.8）：spec-writer（proposal → spec）、architect（→ design.md）、planner（→ tasks.md）。
// agent 对工作区只读，只能通过 submit_* 平台工具提交草稿；引擎先按 G2/G3/G4 的规则校验，
// 不通过就把问题返回给 agent 修改，通过后由引擎写入 openspec/changes/<id>/。人工审批仍由人完成。

export type ArtifactKind = 'spec' | 'design' | 'tasks';

export const ARTIFACT_ROLE: Record<ArtifactKind, AgentRole> = { spec: 'spec-writer', design: 'architect', tasks: 'planner' };

export interface ArtifactFile {
  /** 相对 openspec/changes/<id>/ 的路径 */
  path: string;
  content: string;
}

export interface ArtifactDraft {
  submitted: boolean;
  files: ArtifactFile[];
  summary?: string;
  questions: RaisedQuestion[];
}

export interface ArtifactContext {
  kind: ArtifactKind;
  changeId: string;
  title: string;
  /** 上游材料原文（proposal / spec / design） */
  sources: { path: string; text: string }[];
  /** 需求复述 */
  restatement?: string;
  /** 已确认的问题与答案 */
  decisions: { id: string; question: string; answer: string }[];
  /** 已确认的假设 */
  assumptions?: string[];
  conventions?: string;
  raise?: RaiseContext;
  /** 引擎提供的校验：返回不通过的项，空数组表示通过 */
  validate: (files: ArtifactFile[]) => string[];
}

export function emptyArtifactDraft(): ArtifactDraft {
  return { submitted: false, files: [], questions: [] };
}

const CAPABILITY = /^[a-z0-9][a-z0-9-]*$/;

function submit(draft: ArtifactDraft, ctx: ArtifactContext, files: ArtifactFile[], summary: string): string {
  if (draft.submitted) throw new Error('已经提交过结果');
  const problems = ctx.validate(files);
  if (problems.length) throw new Error(`未通过引擎校验，请修改后重新提交：\n- ${problems.join('\n- ')}`);
  Object.assign(draft, { submitted: true, files, summary });
  return '已通过校验，等待引擎写入';
}

export function artifactTools(draft: ArtifactDraft, ctx: ArtifactContext): PlatformTool[] {
  const tools: PlatformTool[] = [];
  if (ctx.kind === 'spec') {
    tools.push(
      defineTool({
        name: 'submit_spec',
        description: '提交规格。每个 capability 一个 spec.md（OpenSpec 格式），写到 specs/<capability>/spec.md。引擎会校验 AC 编号与问题引用，不通过会返回问题。',
        shape: {
          specs: z.array(z.object({ capability: z.string(), content: z.string().min(20) })).min(1),
          summary: z.string().min(2),
        },
        handler: ({ specs, summary }) => {
          const bad = specs.filter((s) => !CAPABILITY.test(s.capability)).map((s) => s.capability);
          if (bad.length) throw new Error(`capability 只能是小写字母、数字和连字符：${bad.join(', ')}`);
          const names = specs.map((s) => s.capability);
          if (new Set(names).size !== names.length) throw new Error('capability 重复');
          return submit(draft, ctx, specs.map((s) => ({ path: `specs/${s.capability}/spec.md`, content: s.content })), summary);
        },
      }),
    );
  } else {
    const file = ctx.kind === 'design' ? 'design.md' : 'tasks.md';
    tools.push(
      defineTool({
        name: ctx.kind === 'design' ? 'submit_design' : 'submit_tasks',
        description: `提交 ${file} 的完整内容。引擎会按${ctx.kind === 'design' ? '方案门（G3）' : '任务门（G4）'}的规则校验，不通过会返回问题。`,
        shape: { content: z.string().min(20), summary: z.string().min(2) },
        handler: ({ content, summary }) => submit(draft, ctx, [{ path: file, content }], summary),
      }),
    );
  }
  tools.push(raiseQuestionTool(draft.questions, ctx.raise ?? { questionIds: [], taskIds: [] }));
  return tools;
}

const COMMON_RULES = `- 你对代码库只读：可以用 Read / Glob / Grep 了解现有代码，但不能修改任何文件；产物只能通过提交工具交给引擎。
- 只依据已确认的需求复述、问题答案和假设，不要扩大范围，不要加入需求没提到的功能。
- ${RAISE_QUESTION_RULE}提出 blocking 问题后可以不提交，等人回答后重新生成。
- 提交被引擎退回时，按返回的问题修改后重新提交。`;

const SYSTEM: Record<ArtifactKind, string> = {
  spec: `你是 SpecForge 的规格编写 agent（spec-writer）。根据已确认的需求分析，写 OpenSpec 格式的规格。

格式（每个 capability 一个文件）：
## ADDED Requirements

### Requirement: <名称>
系统 SHALL …（引用依据的问题编号，例如"（Q-2）"）

#### Scenario: [AC-1] <场景名>
- **WHEN** …
- **THEN** …

规则：
- 每个 Scenario 标题必须带唯一的 AC 编号 [AC-n]，从 AC-1 开始全局连续编号。
- 每个已确认的问题编号（Q-n）都必须在规格中被引用，说明它决定了哪条规则。
- THEN 要写可验证的结果（返回值、错误信息、状态），不要写"正确处理"之类的空话。
- 覆盖正常、异常、边界场景，但只写需求范围内的。
${COMMON_RULES}
- 最后调用 submit_spec。`,
  design: `你是 SpecForge 的方案设计 agent（architect）。根据已批准的规格和现有代码，写技术方案 design.md。

规则：
- 正文说明每个 AC 怎么实现，逐个引用 AC 编号（AC-n），不得引用规格中不存在的 AC。
- 先阅读现有代码，优先复用已有模块和函数，写清楚改哪些文件、新增哪些函数。
- 必须有「## 结构变更」一节，逐条列出新增的模块 / 接口 / 数据表 / 配置：
  - [S-1] 新增模块 \`src/xxx.js\`
  没有结构变更时写「- 无：<原因>」。只列真正新增的结构，修改已有函数不算。
${COMMON_RULES}
- 最后调用 submit_design。`,
  tasks: `你是 SpecForge 的任务拆分 agent（planner）。根据已批准的规格和方案，写 tasks.md。

格式（每行一个任务）：
- [ ] T-1 <标题>（AC-1, AC-2, S-1）
- [ ] T-2 <标题>（AC-3）依赖 T-1

规则：
- 每个任务都要关联至少一个 AC；每个 AC、每个结构变更 S-n 都要有任务负责。
- 只引用规格和方案中存在的 AC / S 编号；依赖只能指向已有任务，不能有环。
- 每个任务是一次可独立提交、可测试的改动：实现 agent 会先写测试（必须先失败）再实现。不要单独拆"写测试"的任务，测试和实现放在同一个任务里。
- 任务粒度适中：一般 2–6 个任务。
${COMMON_RULES}
- 最后调用 submit_tasks。`,
};

export function artifactSystemPrompt(kind: ArtifactKind): string {
  return SYSTEM[kind];
}

export function artifactPrompt(ctx: ArtifactContext): string {
  const parts = [`# ${ctx.kind === 'spec' ? '编写规格' : ctx.kind === 'design' ? '编写技术方案' : '拆分任务'}：${ctx.title}（change: ${ctx.changeId}）`];
  if (ctx.restatement) parts.push('', '## 已确认的需求复述', ctx.restatement);
  if (ctx.decisions.length) parts.push('', '## 已确认的需求决定', ...ctx.decisions.map((d) => `- ${d.id}：${d.question}\n  答：${d.answer}`));
  if (ctx.assumptions?.length) parts.push('', '## 已确认的假设', ...ctx.assumptions.map((a) => `- ${a}`));
  parts.push('', '## 上游材料', ...(ctx.sources.length ? ctx.sources.map((s) => `### ${s.path}\n${s.text.trim()}`) : ['（无）']));
  if (ctx.conventions?.trim()) parts.push('', '## 项目约定', ctx.conventions.trim());
  parts.push('', '请开始。');
  return parts.join('\n');
}
