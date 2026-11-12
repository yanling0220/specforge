import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  adapterFor,
  analystPrompt,
  analystTools,
  ANALYST_SYSTEM_PROMPT,
  applyAnalysisDraft,
  emptyAnalysisDraft,
  emptyReviewDraft,
  resolveProfile,
  reviewerPrompt,
  reviewerTools,
  REVIEWER_SYSTEM_PROMPT,
  reviewRecordFromDraft,
  type AgentAdapter,
  type AgentEvent,
  type AgentRunResult,
  type AgentRunSpec,
} from '@specforge/agents';
import { acIdsOf, ForgeError } from '@specforge/core';
import { diffStat, fullDiff, headSha, workspaceFingerprint } from '@specforge/runner';
import type { Actor, AgentProfile, AgentRole, ProjectConfig } from '@specforge/shared';
import { readSpecFacts } from './engine.ts';
import type { Store } from './store.ts';

const MAX_DIFF_CHARS = 150_000;
const CONVENTION_FILES = ['AGENTS.md', 'CLAUDE.md'];

export interface AgentCmdOptions {
  override: Partial<AgentProfile>;
  verbose: boolean;
  /** 测试注入用；默认按配置选择后端 */
  adapter?: AgentAdapter;
  log?: (line: string) => void;
}

function readConventions(root: string): string {
  return CONVENTION_FILES.filter((f) => existsSync(join(root, f)))
    .map((f) => `### ${f}\n${readFileSync(join(root, f), 'utf8').slice(0, 20_000)}`)
    .join('\n\n');
}

/** 问题分类 = 确认策略中的类别 ∪ 分析维度；未在策略中列出的按 default 确认 */
function questionCategories(config: ProjectConfig): { name: string; roles: string[] }[] {
  const names = [...new Set([...Object.keys(config.confirmPolicy).filter((k) => k !== 'default'), ...config.dimensions, '技术约束', '其他'])];
  return names.map((name) => ({ name, roles: config.confirmPolicy[name] ?? config.confirmPolicy.default }));
}

function printer(verbose: boolean, log: (l: string) => void) {
  return (e: AgentEvent) => {
    if (e.kind === 'denied') log(`  ⛔ 拦截 ${e.name}：${e.reason}`);
    else if (e.kind === 'tool') log(`  · ${e.name.replace(/^mcp__specforge__/, '')}${verbose ? ` ${JSON.stringify(e.input).slice(0, 200)}` : ''}`);
    else if (verbose) log(`  ${e.text.slice(0, 400)}`);
  };
}

/**
 * 运行只读 agent，并做事后校验（设计文档 5 ④）：运行前后工作区必须完全一致，
 * 否则丢弃全部产出。无论成败都写一条 agent.run 事件。
 */
async function runReadOnly(
  store: Store,
  changeId: string,
  actor: Actor,
  role: AgentRole,
  build: (profile: AgentProfile) => Omit<AgentRunSpec, 'profile' | 'cwd' | 'readOnly' | 'toolNamespace' | 'onEvent'>,
  opts: AgentCmdOptions,
): Promise<{ result: AgentRunResult; profile: AgentProfile }> {
  const log = opts.log ?? console.log;
  const profile = resolveProfile(role, store.config().agents, opts.override);
  const adapter = opts.adapter ?? adapterFor(profile);
  const before = workspaceFingerprint(store.root);
  log(`启动 ${role} agent（${adapter.backend}${profile.model ? ` · ${profile.model}` : ''}${profile.provider ? ` · ${profile.provider}` : ''} · effort ${profile.effort ?? '默认'}）…`);
  let result: AgentRunResult;
  try {
    result = await adapter.run({
      ...build(profile),
      profile,
      cwd: store.root,
      readOnly: true,
      toolNamespace: 'specforge',
      onEvent: printer(opts.verbose, log),
    });
  } catch (e) {
    result = { ok: false, error: (e as Error).message, backend: adapter.backend, turns: 0, costUsd: 0, durationMs: 0, deniedTools: [] };
  }
  const tampered = workspaceFingerprint(store.root) !== before;
  if (tampered) {
    result = { ...result, ok: false, error: '只读 agent 运行后工作区发生了变化，产出已丢弃，请检查工作区' };
  }
  store.append({
    type: 'agent.run',
    actor,
    changeId,
    payload: {
      role,
      backend: result.backend,
      model: result.model ?? profile.model,
      sessionId: result.sessionId,
      ok: result.ok,
      error: result.error,
      turns: result.turns,
      costUsd: result.costUsd,
      tokens: result.tokens,
      durationMs: result.durationMs,
      deniedTools: result.deniedTools,
      workspaceChanged: tampered,
    },
  });
  const spend = result.costUsd > 0 ? `$${result.costUsd.toFixed(4)}` : result.tokens ? `${result.tokens.input}+${result.tokens.output} tokens` : '费用未知';
  log(`${result.ok ? '✓' : '✗'} 结束：${result.turns} 轮 · ${spend} · ${(result.durationMs / 1000).toFixed(1)}s${result.error ? ` · ${result.error}` : ''}`);
  if (!result.ok) throw new ForgeError('agent_failed', `${role} agent 运行失败：${result.error ?? '未知原因'}`);
  return { result, profile };
}

function agentActor(role: AgentRole, result: AgentRunResult, profile: AgentProfile): Actor {
  return { name: `${role}@${result.backend}/${result.model ?? profile.model ?? 'default'}`, role: 'agent' };
}

export async function cmdAgentAnalyze(store: Store, changeId: string, actor: Actor, opts: AgentCmdOptions): Promise<void> {
  const log = opts.log ?? console.log;
  const state = store.load(changeId);
  const config = store.config();
  const proposalPath = join(store.openspecChangeDir(changeId), 'proposal.md');
  const proposal = existsSync(proposalPath) ? readFileSync(proposalPath, 'utf8') : '';
  const r = state.analysis.restatement;
  const ctx = {
    changeId,
    title: state.change.title,
    proposal,
    dimensions: config.dimensions,
    categories: questionCategories(config),
    conventions: readConventions(store.root),
    existing: {
      restatement: r ? { text: r.text, confirmed: !!r.confirmation && r.confirmation.hash === r.hash } : undefined,
      questions: state.questions,
      assumptions: state.analysis.assumptions,
    },
  };
  const draft = emptyAnalysisDraft();
  const { result, profile } = await runReadOnly(
    store,
    changeId,
    actor,
    'analyst',
    () => ({
      role: 'analyst',
      systemPrompt: ANALYST_SYSTEM_PROMPT,
      prompt: analystPrompt(ctx),
      tools: analystTools(draft, ctx),
      isComplete: () => draft.finished,
      reset: () => Object.assign(draft, emptyAnalysisDraft()),
    }),
    opts,
  );

  const agent = agentActor('analyst', result, profile);
  let summary = '';
  store.mutate(
    changeId,
    agent,
    'analysis.agent_submitted',
    (s) => {
      const applied = applyAnalysisDraft(s.analysis, s.questions, draft, config, agent, s.change.stage, new Date().toISOString());
      summary = [
        applied.restatementChanged ? '复述已更新（待确认）' : '复述未变',
        `${draft.nodes.length} 个分解节点`,
        `${draft.assumptions.length} 条新假设`,
        `${draft.questions.length} 个新问题${Object.keys(applied.idMap).length ? `（${Object.values(applied.idMap).join(', ')}）` : ''}`,
        applied.skippedDimensions.length ? `人已下结论的维度未覆盖：${applied.skippedDimensions.join('、')}` : '',
      ]
        .filter(Boolean)
        .join('；');
      return { ...s, analysis: applied.analysis, questions: applied.questions };
    },
    (s) => ({
      sessionId: result.sessionId,
      summary: draft.summary,
      restatementHash: s.analysis.restatement?.hash,
      questionIds: s.questions.slice(state.questions.length).map((q) => q.id),
      assumptions: draft.assumptions.length,
      nodes: draft.nodes.length,
    }),
  );
  log(`分析已写入：${summary}`);
  if (draft.summary) log(`agent 总结：${draft.summary}`);
  log(`下一步：sf q list ${changeId}，与产品核对后回答问题`);
}

export async function cmdAgentReview(store: Store, changeId: string, actor: Actor, opts: AgentCmdOptions): Promise<void> {
  const log = opts.log ?? console.log;
  const state = store.load(changeId);
  if (state.change.stage !== 'closing') {
    throw new ForgeError('bad_stage', `独立审查在 closing 阶段进行，当前是 ${state.change.stage}`);
  }
  const sha = headSha(store.root);
  const facts = readSpecFacts(store, changeId);
  let diff = fullDiff(store.root, state.change.baseSha, sha);
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS) + `\n…（diff 过长已截断，请用 Read 查看完整文件）`;
  }
  const ctx = {
    changeId,
    title: state.change.title,
    sha,
    baseSha: state.change.baseSha,
    acIds: acIdsOf(facts.specs),
    sources: facts.sources,
    decisions: state.questions
      .filter((q) => q.status === 'confirmed')
      .map((q) => ({ id: q.id, question: q.question, answer: q.revisions.at(-1)!.text })),
    diffStat: diffStat(store.root, state.change.baseSha, sha),
    diff,
    conventions: readConventions(store.root),
  };
  const draft = emptyReviewDraft();
  const { result, profile } = await runReadOnly(
    store,
    changeId,
    actor,
    'reviewer',
    () => ({
      role: 'reviewer',
      systemPrompt: REVIEWER_SYSTEM_PROMPT,
      prompt: reviewerPrompt(ctx),
      tools: reviewerTools(draft, ctx),
      isComplete: () => draft.submitted,
      reset: () => Object.assign(draft, emptyReviewDraft()),
    }),
    opts,
  );
  if (headSha(store.root) !== sha) throw new ForgeError('head_moved', '审查期间 HEAD 发生了变化，结论作废，请重新审查');
  const agent = agentActor('reviewer', result, profile);
  const record = reviewRecordFromDraft(draft, sha, agent, new Date().toISOString());
  store.mutate(changeId, agent, 'review.recorded', (s) => ({ ...s, reviews: [...s.reviews, record] }), () => ({ ...record, sessionId: result.sessionId }));
  log(`审查结论：${record.verdict}（commit ${sha.slice(0, 7)}，覆盖 ${record.coverage.join(', ') || '无'}）`);
  for (const f of record.findings) {
    log(`  ${f.severity === 'blocking' ? '🔴' : '⚪'} ${f.anchor ? `[${f.anchor}] ` : ''}${f.kind ? `(${f.kind}) ` : ''}${f.text}`);
  }
  if (record.note) log(`总结：${record.note}`);
}
