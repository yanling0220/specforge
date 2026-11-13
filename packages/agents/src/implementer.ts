import { z } from 'zod';
import { RAISE_QUESTION_RULE, raiseQuestionTool, type RaiseContext, type RaisedQuestion } from './raise-question.ts';
import { defineTool, type PlatformTool } from './types.ts';

// 实现 agent：在独立 worktree 中实现一个任务。它能改代码、跑测试，
// 但提交、勾选任务、合入主分支都由引擎完成。

export interface ImplementDraft {
  finished: boolean;
  blocked?: string;
  summary?: string;
  testsAdded: string[];
  /** raise_question 提出的问题，运行结束后由引擎写入 */
  questions: RaisedQuestion[];
}

export interface ImplementerContext {
  changeId: string;
  title: string;
  task: { id: string; title: string; acRefs: string[]; structureRefs: string[] };
  /** spec.md / proposal.md / design.md / tasks.md 原文 */
  sources: { path: string; text: string }[];
  decisions: { id: string; question: string; answer: string }[];
  verifyCommands: { name: string; command: string }[];
  forbidden: string[];
  conventions?: string;
  raise?: RaiseContext;
}

export function emptyImplementDraft(): ImplementDraft {
  return { finished: false, testsAdded: [], questions: [] };
}

export function implementerTools(draft: ImplementDraft, ctx: ImplementerContext): PlatformTool[] {
  const open = () => {
    if (draft.finished || draft.blocked) throw new Error('已经提交过结果');
  };
  return [
    defineTool({
      name: 'finish_task',
      description: [
        `完成任务 ${ctx.task.id}。调用前应已实现代码、补充测试并运行通过。`,
        `testsAdded 列出新增或修改的测试名称；测试名称中必须包含对应的 AC 编号（${ctx.task.acRefs.join(', ')}），例如 "[AC-1] …"。`,
      ].join('\n'),
      shape: { summary: z.string().min(4), testsAdded: z.array(z.string()).min(1) },
      handler: ({ summary, testsAdded }) => {
        open();
        if (draft.questions.some((q) => q.severity === 'blocking')) throw new Error('已提出阻塞问题，任务暂停：请调用 report_blocked 结束');
        const missing = ctx.task.acRefs.filter((ac) => !testsAdded.some((t) => t.includes(`[${ac}]`)));
        if (missing.length) throw new Error(`testsAdded 中没有覆盖：${missing.join(', ')}（测试名称需包含 [AC-n]）`);
        Object.assign(draft, { finished: true, summary, testsAdded });
        return '已提交，等待引擎校验并提交代码';
      },
    }),
    defineTool({
      name: 'report_blocked',
      description: '无法在不违反规格或约束的前提下完成任务时调用（例如需求有歧义、需要改 spec 或受保护文件）。改动会被丢弃，由人处理。',
      shape: { reason: z.string().min(4) },
      handler: ({ reason }) => {
        open();
        draft.blocked = reason;
        return '已报告阻塞';
      },
    }),
    raiseQuestionTool(draft.questions, ctx.raise ?? { questionIds: [], taskIds: [ctx.task.id], defaultTaskIds: [ctx.task.id] }),
  ];
}

export const IMPLEMENTER_SYSTEM_PROMPT = `你是 SpecForge 的实现 agent。你在一个独立的 git worktree 中工作，只实现被分配的一个任务。

规则：
- 只做这个任务要求的事。不要顺手重构、不要实现其他任务、不要新增方案「结构变更」清单之外的模块 / 接口 / 数据表。
- 先写或补充测试，再写实现。测试名称包含对应的 AC 编号，例如 "[AC-1] 拒绝超限文件"。
- 引擎会做 TDD 检查（G5）：把你新增或修改的测试文件放到实现前的代码上运行，必须失败；在你的实现上运行，必须通过。所以测试必须真正验证本任务的新行为，并放在测试文件中（不要只改实现）。
- 不要跳过、删除或弱化已有测试；不要修改测试配置、lint 规则、CI 等受保护文件。
- 不要修改 openspec/ 和 .specforge/：规格和任务清单由引擎维护。
- 不要 git commit / push，也不要改动工作目录之外的任何文件；提交由引擎完成。
- 运行项目的验证命令，确认通过后调用 finish_task。
- ${RAISE_QUESTION_RULE}提出 blocking 问题后任务会暂停：调用 report_blocked 结束，改动会被丢弃，等人回答后重做。
- 必须违反约束（改 spec、受保护文件）才能完成时，调用 report_blocked。`;

export function implementerPrompt(ctx: ImplementerContext): string {
  const parts = [
    `# 任务 ${ctx.task.id}：${ctx.task.title}`,
    `change：${ctx.changeId}（${ctx.title}）`,
    `关联验收标准：${ctx.task.acRefs.join(', ')}${ctx.task.structureRefs.length ? `；关联结构变更：${ctx.task.structureRefs.join(', ')}` : ''}`,
    '',
    '## 已批准的材料',
    ...ctx.sources.map((s) => `### ${s.path}\n${s.text.trim()}`),
  ];
  if (ctx.decisions.length) parts.push('', '## 已确认的需求决定', ...ctx.decisions.map((d) => `- ${d.id}：${d.question}\n  答：${d.answer}`));
  if (ctx.conventions?.trim()) parts.push('', '## 项目约定', ctx.conventions.trim());
  parts.push(
    '',
    '## 验证命令',
    ...ctx.verifyCommands.map((v) => `- ${v.name}：\`${v.command}\``),
    '',
    '## 禁止修改的路径',
    ...ctx.forbidden.map((f) => `- ${f}`),
    '',
    '请开始实现。',
  );
  return parts.join('\n');
}
