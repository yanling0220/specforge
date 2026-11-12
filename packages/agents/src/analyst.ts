import { z } from 'zod';
import type { DimensionStatus, Question, RequirementNode, Severity } from '@specforge/shared';
import { defineTool, type PlatformTool } from './types.ts';

// 需求分析 agent：只读代码库，通过平台工具提交结构化分析。
// 工具只把结果累积到草稿里，运行结束后由引擎校验并落盘（AI 不能直接改状态）。

export interface DraftQuestion {
  category: string;
  severity: Severity;
  question: string;
  why: string;
  evidence?: string;
  nodeId?: string;
  options: { id: string; text: string; impact?: string; recommended?: boolean }[];
  defaultOptionId?: string;
  /** 依赖的问题：可以是已有问题编号（Q-n），也可以是本轮草稿编号（D-n） */
  dependsOn: string[];
}

export interface AnalysisDraft {
  restatement?: string;
  nodes: RequirementNode[];
  assumptions: string[];
  dimensions: { dimension: string; status: Exclude<DimensionStatus, 'pending'>; reason?: string; draftQuestionIds?: string[] }[];
  questions: DraftQuestion[];
  finished: boolean;
  summary?: string;
}

export interface AnalystContext {
  changeId: string;
  title: string;
  /** proposal.md 原文（开发者写的需求描述） */
  proposal: string;
  dimensions: string[];
  /** 项目约定（AGENTS.md / CLAUDE.md 等） */
  conventions?: string;
  existing: {
    restatement?: { text: string; confirmed: boolean };
    questions: Question[];
    assumptions: { id: string; text: string; status: string }[];
  };
}

export function emptyAnalysisDraft(): AnalysisDraft {
  return { nodes: [], assumptions: [], dimensions: [], questions: [], finished: false };
}

const severity = z.enum(['blocking', 'important', 'minor']);

export function analystTools(draft: AnalysisDraft, ctx: AnalystContext): PlatformTool[] {
  const knownDims = new Set(ctx.dimensions);
  const existingQ = new Set(ctx.existing.questions.map((q) => q.id));
  const requireOpen = () => {
    if (draft.finished) throw new Error('已经调用过 finish_analysis，不能再提交');
  };

  return [
    defineTool({
      name: 'set_restatement',
      description: '用你自己的话复述需求：做什么、为谁做、为什么做。2–5 句，不要加入需求里没有的内容。',
      shape: { text: z.string().min(10) },
      handler: ({ text }) => {
        requireOpen();
        draft.restatement = text;
        return '已记录复述';
      },
    }),
    defineTool({
      name: 'set_requirement_tree',
      description: '提交需求分解树：goal → feature → scenario（正常、异常、边界）。id 用 G1 / F1 / F1.S1 这样的格式。整棵树一次提交，再次调用会覆盖。',
      shape: {
        nodes: z.array(
          z.object({
            id: z.string().regex(/^[A-Z][A-Z0-9.]*$/),
            parentId: z.string().optional(),
            kind: z.enum(['goal', 'feature', 'scenario']),
            title: z.string().min(1),
          }),
        ),
      },
      handler: ({ nodes }) => {
        requireOpen();
        const ids = new Set(nodes.map((n) => n.id));
        if (ids.size !== nodes.length) throw new Error('节点 id 重复');
        const bad = nodes.filter((n) => n.parentId && !ids.has(n.parentId)).map((n) => n.id);
        if (bad.length) throw new Error(`父节点不存在：${bad.join(', ')}`);
        draft.nodes = nodes;
        return `已记录 ${nodes.length} 个节点`;
      },
    }),
    defineTool({
      name: 'add_assumption',
      description: '记录一条你在分析中做出的假设（例如"沿用现有鉴权"）。每条假设都会交给人确认或否决。',
      shape: { text: z.string().min(4) },
      handler: ({ text }) => {
        requireOpen();
        draft.assumptions.push(text);
        return `已记录假设 #${draft.assumptions.length}`;
      },
    }),
    defineTool({
      name: 'raise_question',
      description: [
        '提出一个需要人回答的问题。遇到歧义必须提问，不许猜。',
        'severity：blocking = 不回答就无法正确实现；important = 影响设计但有合理默认；minor = 细节。',
        '尽量给出 2–4 个选项并标注影响和推荐项；blocking 问题不能设默认选项。',
        'evidence 写依据，最好是 文件:行号。返回本轮草稿编号 D-n，可在 dependsOn 和 set_dimension 中引用。',
      ].join('\n'),
      shape: {
        category: z.string().min(1),
        severity,
        question: z.string().min(4),
        why: z.string().min(4),
        evidence: z.string().optional(),
        nodeId: z.string().optional(),
        options: z
          .array(z.object({ id: z.string().regex(/^[A-Z]$/), text: z.string().min(1), impact: z.string().optional(), recommended: z.boolean().optional() }))
          .default([]),
        defaultOptionId: z.string().optional(),
        dependsOn: z.array(z.string()).default([]),
      },
      handler: (q) => {
        requireOpen();
        if (q.severity === 'blocking' && q.defaultOptionId) throw new Error('blocking 问题不能设默认选项');
        if (q.defaultOptionId && !q.options.some((o) => o.id === q.defaultOptionId)) throw new Error('默认选项不在选项列表中');
        if (q.nodeId && !draft.nodes.some((n) => n.id === q.nodeId)) throw new Error(`节点 ${q.nodeId} 不在需求分解树中，请先提交分解树`);
        const unknown = q.dependsOn.filter((d) => !existingQ.has(d) && !/^D-\d+$/.test(d));
        if (unknown.length) throw new Error(`dependsOn 引用了不存在的问题：${unknown.join(', ')}`);
        draft.questions.push(q);
        return `已记录问题 D-${draft.questions.length}`;
      },
    }),
    defineTool({
      name: 'set_dimension',
      description: '给一个分析维度下结论。status：covered = 需求已说清；question = 有问题（必须关联 D-n 或 Q-n）；na = 不适用（必须写原因）。',
      shape: {
        dimension: z.string(),
        status: z.enum(['covered', 'question', 'na']),
        reason: z.string().optional(),
        questionIds: z.array(z.string()).default([]),
      },
      handler: ({ dimension, status, reason, questionIds }) => {
        requireOpen();
        if (!knownDims.has(dimension)) throw new Error(`未知维度「${dimension}」，可用：${ctx.dimensions.join('、')}`);
        if (status === 'na' && !reason?.trim()) throw new Error('na 必须写原因');
        if (status === 'question' && !questionIds.length) throw new Error('question 必须关联问题编号');
        const dangling = questionIds.filter((id) => {
          const m = /^D-(\d+)$/.exec(id);
          return m ? Number(m[1]) > draft.questions.length || Number(m[1]) < 1 : !existingQ.has(id);
        });
        if (dangling.length) throw new Error(`引用了不存在的问题：${dangling.join(', ')}`);
        draft.dimensions = draft.dimensions.filter((d) => d.dimension !== dimension);
        draft.dimensions.push({ dimension, status, reason, draftQuestionIds: questionIds });
        return `「${dimension}」→ ${status}`;
      },
    }),
    defineTool({
      name: 'finish_analysis',
      description: '完成分析。调用前必须已提交复述、分解树，并对每个维度下了结论。',
      shape: { summary: z.string().min(2) },
      handler: ({ summary }) => {
        requireOpen();
        const missing: string[] = [];
        if (!draft.restatement && !ctx.existing.restatement) missing.push('需求复述');
        if (!draft.nodes.length) missing.push('需求分解树');
        const done = new Set(draft.dimensions.map((d) => d.dimension));
        const undecided = ctx.dimensions.filter((d) => !done.has(d));
        if (undecided.length) missing.push(`维度结论（${undecided.join('、')}）`);
        if (missing.length) throw new Error(`还缺：${missing.join('；')}`);
        draft.finished = true;
        draft.summary = summary;
        return '分析已提交，等待人工核对';
      },
    }),
  ];
}

export const ANALYST_SYSTEM_PROMPT = `你是 SpecForge 的需求分析 agent。你的产出会交给开发人员和产品核对，然后作为后续规格和实现的唯一依据。

工作方式：
- 先阅读需求，再用 Read / Glob / Grep 调查现有代码库，弄清楚现状：相关模块、已有约束、可复用的东西。
- 你只能读，不能修改任何文件。所有结论必须通过平台工具提交，写在回复正文里的内容不会被记录。
- 遇到歧义必须用 raise_question 提问，不许猜。能从代码中查到的事实不要问人，写进 evidence。
- 问题要具体、可回答，给出选项和影响；不要问空泛的问题，也不要把同一件事拆成多个问题。
- 你做出的任何假设都必须用 add_assumption 记录。
- 不要扩大需求范围。需求没提到的功能，用"范围外事项"维度说明或提问，不要自行加入。
- 最后调用 finish_analysis。`;

export function analystPrompt(ctx: AnalystContext): string {
  const parts = [`# 需求：${ctx.title}（change: ${ctx.changeId}）`, '', '## 需求描述（proposal.md）', ctx.proposal.trim() || '（空）'];
  if (ctx.conventions?.trim()) parts.push('', '## 项目约定', ctx.conventions.trim());
  parts.push('', '## 分析维度（每个都要用 set_dimension 下结论）', ctx.dimensions.map((d) => `- ${d}`).join('\n'));

  const { restatement, questions, assumptions } = ctx.existing;
  if (restatement || questions.length || assumptions.length) {
    parts.push('', '## 上一轮的结果（这是增量分析）');
    if (restatement) parts.push(`需求复述（${restatement.confirmed ? '已确认，除非发现明显错误否则不要改' : '未确认'}）：${restatement.text}`);
    for (const q of questions) {
      const rev = q.revisions.at(-1);
      const ans = q.status === 'confirmed' && rev ? `已确认答案：${rev.text}` : q.status;
      parts.push(`- ${q.id} [${q.severity}] ${q.question} → ${ans}`);
    }
    for (const a of assumptions) parts.push(`- 假设 ${a.id}：${a.text}（${a.status}）`);
    parts.push('已确认的答案是既定事实。只提出新的问题：例如由已确认答案派生出的问题，或上一轮遗漏的问题。不要重复已有问题。');
  }
  parts.push('', '请开始分析。');
  return parts.join('\n');
}
