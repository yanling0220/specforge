import { z } from 'zod';
import type { Severity } from '@specforge/shared';
import { defineTool, type PlatformTool } from './types.ts';

// 问题回流（设计文档 3.5）：分析之后的各阶段 agent 遇到歧义都通过 raise_question 提问。
// 问题只记在草稿里，由引擎在运行结束后写入（Store.mutate），agent 不能直接改状态。

export interface RaisedQuestion {
  category: string;
  severity: Severity;
  question: string;
  why: string;
  evidence?: string;
  options: { id: string; text: string; impact?: string; recommended?: boolean }[];
  defaultOptionId?: string;
  dependsOn: string[];
  taskIds: string[];
}

export interface RaiseContext {
  categories?: { name: string; roles: string[] }[];
  /** 已有问题编号，供 dependsOn 引用 */
  questionIds: string[];
  /** tasks.md 中的任务编号 */
  taskIds: string[];
  /** 未指定 taskIds 时默认关联的任务（实现 agent 是当前任务） */
  defaultTaskIds?: string[];
}

export const RAISE_QUESTION_RULE =
  '遇到规格、方案或已确认答案都没有说清的业务规则，必须用 raise_question 提问，不许猜，也不要自行写死规则。';

export function raiseQuestionTool(out: RaisedQuestion[], ctx: RaiseContext): PlatformTool {
  const categoryNames = ctx.categories?.map((c) => c.name) ?? [];
  return defineTool({
    name: 'raise_question',
    description: [
      '向人提出一个问题（由开发 / 产品核对后回答）。遇到歧义必须提问，不许猜。',
      'severity：blocking = 不回答就无法正确完成（会暂停关联任务并阻止流程推进）；important = 有合理默认但需要确认；minor = 细节。',
      '尽量给出 2–4 个选项并标注影响；blocking 问题不能设默认选项。evidence 写依据，最好是 文件:行号。',
      `taskIds：受影响的任务（${ctx.taskIds.join(', ') || '无'}）；${ctx.defaultTaskIds?.length ? `不填默认为 ${ctx.defaultTaskIds.join(', ')}` : '不填表示影响全部任务'}。`,
      categoryNames.length ? `category 只能是：${categoryNames.join('、')}。答案取决于业务决策时，选需要 product 确认的分类。` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    shape: {
      category: z.string().min(1),
      severity: z.enum(['blocking', 'important', 'minor']),
      question: z.string().min(4),
      why: z.string().min(4),
      evidence: z.string().optional(),
      options: z
        .array(z.object({ id: z.string().regex(/^[A-Z]$/), text: z.string().min(1), impact: z.string().optional(), recommended: z.boolean().optional() }))
        .default([]),
      defaultOptionId: z.string().optional(),
      dependsOn: z.array(z.string()).default([]),
      taskIds: z.array(z.string()).default([]),
    },
    handler: (q) => {
      if (categoryNames.length && !categoryNames.includes(q.category)) throw new Error(`category 必须是以下之一：${categoryNames.join('、')}`);
      if (q.severity === 'blocking' && q.defaultOptionId) throw new Error('blocking 问题不能设默认选项');
      if (q.defaultOptionId && !q.options.some((o) => o.id === q.defaultOptionId)) throw new Error('默认选项不在选项列表中');
      const unknownQ = q.dependsOn.filter((d) => !ctx.questionIds.includes(d));
      if (unknownQ.length) throw new Error(`dependsOn 引用了不存在的问题：${unknownQ.join(', ')}`);
      const unknownT = q.taskIds.filter((t) => !ctx.taskIds.includes(t));
      if (unknownT.length) throw new Error(`taskIds 引用了不存在的任务：${unknownT.join(', ')}`);
      out.push({ ...q, taskIds: q.taskIds.length ? q.taskIds : (ctx.defaultTaskIds ?? []) });
      return `已记录问题（第 ${out.length} 个），运行结束后由引擎写入${q.severity === 'blocking' ? '；这是阻塞问题，关联任务会暂停' : ''}`;
    },
  });
}
