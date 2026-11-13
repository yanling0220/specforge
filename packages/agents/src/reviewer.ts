import { z } from 'zod';
import type { ReviewFinding } from '@specforge/shared';
import { RAISE_QUESTION_RULE, raiseQuestionTool, type RaiseContext, type RaisedQuestion } from './raise-question.ts';
import { defineTool, type PlatformTool } from './types.ts';

// 独立审查 agent（G6 6B）：新上下文，只看 spec / 已确认的问题答案 / diff，
// 不看实现过程。必须给出覆盖范围回执；阻塞问题必须锚定到已批准材料。

export interface ReviewDraft {
  submitted: boolean;
  verdict?: 'pass' | 'fail';
  coverage: string[];
  findings: ReviewFinding[];
  summary?: string;
  /** raise_question 提出的问题，运行结束后由引擎写入 */
  questions: RaisedQuestion[];
}

export interface ReviewerContext {
  changeId: string;
  title: string;
  sha: string;
  baseSha: string;
  acIds: string[];
  /** spec.md / proposal.md 原文 */
  sources: { path: string; text: string }[];
  /** 已确认的问题与答案 */
  decisions: { id: string; question: string; answer: string }[];
  diffStat: string;
  diff: string;
  conventions?: string;
  raise?: RaiseContext;
}

export function emptyReviewDraft(): ReviewDraft {
  return { submitted: false, coverage: [], findings: [], questions: [] };
}

export function reviewerTools(draft: ReviewDraft, ctx: ReviewerContext): PlatformTool[] {
  const anchors = new Set([...ctx.acIds, ...ctx.decisions.map((d) => d.id)]);
  return [
    defineTool({
      name: 'submit_review',
      description: [
        '提交审查结论，只能调用一次。',
        'coverage：你实际核对过的 AC 编号，必须覆盖全部 AC。',
        'findings：blocking 问题必须带 kind（missing 漏做 / regression 破坏已有 / unplanned 计划外新增）',
        '和 anchor（AC 编号或问题编号 Q-n）。没有锚点的意见只能是 non-blocking。',
        '存在 blocking 问题时 verdict 必须是 fail。',
      ].join('\n'),
      shape: {
        verdict: z.enum(['pass', 'fail']),
        coverage: z.array(z.string()),
        findings: z
          .array(
            z.object({
              severity: z.enum(['blocking', 'non-blocking']),
              kind: z.enum(['missing', 'regression', 'unplanned']).optional(),
              anchor: z.string().optional(),
              text: z.string().min(4),
            }),
          )
          .default([]),
        summary: z.string().min(2),
      },
      handler: ({ verdict, coverage, findings, summary }) => {
        if (draft.submitted) throw new Error('已经提交过审查结论');
        const uncovered = ctx.acIds.filter((id) => !coverage.includes(id));
        if (uncovered.length) throw new Error(`coverage 缺少：${uncovered.join(', ')}。请核对后再提交`);
        for (const f of findings.filter((x) => x.severity === 'blocking')) {
          if (!f.kind) throw new Error(`阻塞问题缺少 kind：${f.text}`);
          if (!f.anchor || !anchors.has(f.anchor)) {
            throw new Error(`阻塞问题的锚点必须是已批准材料中的编号（${[...anchors].join(', ')}）：${f.text}`);
          }
        }
        const hasBlocking = findings.some((f) => f.severity === 'blocking');
        if (hasBlocking && verdict === 'pass') throw new Error('存在阻塞问题时 verdict 不能是 pass');
        if (!hasBlocking && verdict === 'fail') throw new Error('verdict 为 fail 时必须至少有一个带锚点的阻塞问题');
        Object.assign(draft, { submitted: true, verdict, coverage, findings, summary });
        return '审查结论已提交';
      },
    }),
    raiseQuestionTool(draft.questions, ctx.raise ?? { questionIds: [], taskIds: [] }),
  ];
}

export const REVIEWER_SYSTEM_PROMPT = `你是 SpecForge 的独立代码审查 agent。你没有参与实现，只依据已批准的规格和已确认的需求决定来判断这次改动。

审查要点：
- 每个 AC 是否真的被实现、并且有能证明它的测试（不是只出现了编号）。
- 漏做（missing）：spec 或已确认答案要求的行为没实现。
- 破坏已有（regression）：改动破坏了原有行为或对外契约。
- 计划外新增（unplanned）：spec 没要求的功能、接口、配置，或 design.md「结构变更」清单之外新增的模块 / 接口 / 数据表；代码里写死了在 spec 和答案中找不到依据的业务规则（未经提问的假设）。
- 测试是否有效：断言是否真的检查了行为，有没有被弱化或绕过。

规则：
- 你只能读，不能修改文件。需要时用 Read / Glob / Grep 查看完整文件和上下文。
- 风格、命名之类的意见只能是 non-blocking。不要因为"可以写得更好"就判 fail。
- 审查建议不构成新需求的授权。
- 发现未经提问的假设（代码写死了 spec 和答案中找不到依据的业务规则）时，用 raise_question 提一个 blocking 问题请人决定，并在 findings 中以 blocking 记录（anchor 填相关 AC）。${RAISE_QUESTION_RULE}
- 最后必须调用一次 submit_review。`;

export function reviewerPrompt(ctx: ReviewerContext): string {
  const parts = [
    `# 审查：${ctx.title}（change: ${ctx.changeId}）`,
    `审查对象：${ctx.baseSha.slice(0, 7)}..${ctx.sha.slice(0, 7)}`,
    '',
    '## 验收标准编号',
    ctx.acIds.join(', ') || '（无）',
    '',
    '## 已批准的规格',
    ...ctx.sources.map((s) => `### ${s.path}\n${s.text.trim()}`),
  ];
  if (ctx.decisions.length) {
    parts.push('', '## 已确认的需求决定', ...ctx.decisions.map((d) => `- ${d.id}：${d.question}\n  答：${d.answer}`));
  }
  if (ctx.conventions?.trim()) parts.push('', '## 项目约定', ctx.conventions.trim());
  parts.push('', '## 改动概览', '```', ctx.diffStat, '```', '', '## Diff', '```diff', ctx.diff, '```', '', '请开始审查。');
  return parts.join('\n');
}
