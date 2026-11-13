import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  adapterFor,
  applyRaisedQuestions,
  analystPrompt,
  analystTools,
  ANALYST_SYSTEM_PROMPT,
  applyAnalysisDraft,
  emptyAnalysisDraft,
  emptyImplementDraft,
  emptyReviewDraft,
  IMPLEMENTER_SYSTEM_PROMPT,
  implementerPrompt,
  implementerTools,
  resolveProfile,
  reviewerPrompt,
  reviewerTools,
  REVIEWER_SYSTEM_PROMPT,
  reviewRecordFromDraft,
  type AgentAdapter,
  type AgentEvent,
  type AgentRunResult,
  type AgentRunSpec,
  type RaisedQuestion,
} from '@specforge/agents';
import { acIdsOf, checkPathPolicy, ForgeError, implementPolicy, markTaskDone, nextTask, pausedTasks, type PathPolicy } from '@specforge/core';
import {
  createWorktree,
  diffStat,
  fullDiff,
  git,
  headSha,
  isDirty,
  removeWorktree,
  stageAllChanges,
  workspaceFingerprint,
} from '@specforge/runner';
import type { Actor, AgentProfile, AgentRole, ProjectConfig } from '@specforge/shared';
import { commitTree, readDesignFacts, readSpecFacts, readTasksFacts } from './engine.ts';
import type { Store } from './store.ts';
import { checkTdd } from './tdd.ts';

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
interface RunPlace {
  /** agent 的工作目录；默认是项目根目录 */
  cwd?: string;
  readOnly: boolean;
  pathPolicy?: PathPolicy;
}

async function runReadOnly(
  store: Store,
  changeId: string,
  actor: Actor,
  role: AgentRole,
  build: (profile: AgentProfile) => Omit<AgentRunSpec, 'profile' | 'cwd' | 'readOnly' | 'toolNamespace' | 'onEvent' | 'pathPolicy'>,
  opts: AgentCmdOptions,
  place: RunPlace = { readOnly: true },
): Promise<{ result: AgentRunResult; profile: AgentProfile }> {
  const log = opts.log ?? console.log;
  const profile = resolveProfile(role, store.config().agents, opts.override);
  const adapter = opts.adapter ?? adapterFor(profile);
  const before = workspaceFingerprint(store.root);
  log(`启动 ${role} agent（${adapter.backend}${profile.model ? ` · ${profile.model}` : ''}${profile.provider ? ` · ${profile.provider}` : ''} · effort ${profile.effort ?? '默认'}）…`);
  let result: AgentRunResult;
  const built = build(profile);
  try {
    result = await adapter.run({
      ...built,
      profile,
      cwd: place.cwd ?? store.root,
      readOnly: place.readOnly,
      pathPolicy: place.pathPolicy,
      toolNamespace: 'specforge',
      onEvent: printer(opts.verbose, log),
    });
  } catch (e) {
    result = { ok: false, error: (e as Error).message, backend: adapter.backend, turns: 0, costUsd: 0, durationMs: 0, deniedTools: [] };
  }
  if (!result.ok && !result.error && built.isComplete && !built.isComplete()) result.error = 'agent 结束时没有完整提交结果';
  const tampered = workspaceFingerprint(store.root) !== before;
  if (tampered) {
    result = {
      ...result,
      ok: false,
      error: place.cwd
        ? 'agent 改动了 worktree 之外的项目工作区，产出已丢弃，请检查项目工作区'
        : '只读 agent 运行后工作区发生了变化，产出已丢弃，请检查工作区',
    };
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

/** 把 agent 提出的问题写入状态（问题回流）；返回新问题编号 */
function recordRaisedQuestions(store: Store, changeId: string, agent: Actor, raised: RaisedQuestion[], log: (l: string) => void): string[] {
  if (!raised.length) return [];
  let ids: string[] = [];
  store.mutate(
    changeId,
    agent,
    'question.raised',
    (s) => {
      const applied = applyRaisedQuestions(s.questions, raised, store.config(), agent, s.change.stage, new Date().toISOString());
      ids = applied.ids;
      return { ...s, questions: applied.questions };
    },
    (s) => ({ questionIds: ids, questions: s.questions.filter((q) => ids.includes(q.id)) }),
  );
  raised.forEach((q, i) => log(`  ❓ ${ids[i]}（${q.severity}${q.taskIds.length ? ` · 关联 ${q.taskIds.join(', ')}` : ''}）${q.question}`));
  return ids;
}

const pauseText = (paused: Map<string, string[]>) => [...paused].map(([t, qs]) => `${t}（等待 ${qs.join(', ')}）`).join('、');

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
  // 审查绑定 commit：规格与方案也读该 commit 中的版本
  const tree = commitTree(store.root, sha);
  const facts = readSpecFacts(store, changeId, tree);
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
    // 方案（含结构变更清单）供审查判断“计划外新增”
    sources: (() => {
      const d = readDesignFacts(store, changeId, tree);
      return d.text ? [...facts.sources, { path: d.path, text: d.text }] : facts.sources;
    })(),
    decisions: state.questions
      .filter((q) => q.status === 'confirmed')
      .map((q) => ({ id: q.id, question: q.question, answer: q.revisions.at(-1)!.text })),
    diffStat: diffStat(store.root, state.change.baseSha, sha),
    diff,
    conventions: readConventions(store.root),
    raise: {
      categories: questionCategories(store.config()),
      questionIds: state.questions.map((q) => q.id),
      taskIds: readTasksFacts(store, changeId, tree)?.tasks.map((t) => t.id) ?? [],
    },
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
  const agent = agentActor('reviewer', result, profile);
  recordRaisedQuestions(store, changeId, agent, draft.questions, log);
  if (headSha(store.root) !== sha) throw new ForgeError('head_moved', '审查期间 HEAD 发生了变化，结论作废，请重新审查');
  const record = reviewRecordFromDraft(draft, sha, agent, new Date().toISOString());
  store.mutate(changeId, agent, 'review.recorded', (s) => ({ ...s, reviews: [...s.reviews, record] }), () => ({ ...record, sessionId: result.sessionId }));
  log(`审查结论：${record.verdict}（commit ${sha.slice(0, 7)}，覆盖 ${record.coverage.join(', ') || '无'}）`);
  for (const f of record.findings) {
    log(`  ${f.severity === 'blocking' ? '🔴' : '⚪'} ${f.anchor ? `[${f.anchor}] ` : ''}${f.kind ? `(${f.kind}) ` : ''}${f.text}`);
  }
  if (record.note) log(`总结：${record.note}`);
}

export async function cmdAgentImplement(store: Store, changeId: string, actor: Actor, opts: AgentCmdOptions & { taskId?: string }): Promise<void> {
  const log = opts.log ?? console.log;
  const state = store.load(changeId);
  const config = store.config();
  if (state.change.stage !== 'implement') throw new ForgeError('bad_stage', `实现在 implement 阶段进行，当前是 ${state.change.stage}`);
  if (isDirty(store.root)) {
    throw new ForgeError('dirty', '项目工作区有未提交的改动（.specforge/ 除外），请先提交：实现在独立 worktree 中进行，并以 fast-forward 合入');
  }
  if (!config.tdd?.command) {
    throw new ForgeError('no_tdd', '.specforge/config.json 缺少 tdd.command（只跑指定测试的命令，如 "node --test {files}"），无法执行 G5 TDD 门');
  }
  // 工作区已确认干净：实现基于 HEAD，材料也读 HEAD 中的版本
  const base = headSha(store.root);
  const tree = commitTree(store.root, base);
  const tasks = readTasksFacts(store, changeId, tree);
  if (!tasks?.tasks.length) throw new ForgeError('no_tasks', `openspec/changes/${changeId}/tasks.md 中没有任务`);
  // 问题回流：未解决的阻塞问题暂停关联任务，互不相关的任务可以继续
  const paused = pausedTasks(tasks.tasks.filter((t) => !t.done), state.questions);
  let task;
  if (opts.taskId) {
    task = tasks.tasks.find((t) => t.id === opts.taskId);
    if (!task) throw new ForgeError('not_found', `任务 ${opts.taskId} 不存在`);
    if (task.done) throw new ForgeError('done', `任务 ${task.id} 已完成`);
    const pending = task.dependsOn.filter((d) => !tasks.tasks.find((t) => t.id === d)?.done);
    if (pending.length) throw new ForgeError('deps', `任务 ${task.id} 的依赖尚未完成：${pending.join(', ')}`);
    if (paused.has(task.id)) throw new ForgeError('paused', `任务 ${task.id} 已暂停，等待阻塞问题的回答：${paused.get(task.id)!.join(', ')}`);
  } else {
    task = nextTask(tasks, paused);
    if (!task) {
      throw new ForgeError('no_task', `没有可做的任务（全部完成，或剩余任务的依赖未完成${paused.size ? `；暂停中：${pauseText(paused)}` : ''}）`);
    }
  }

  const facts = readSpecFacts(store, changeId, tree);
  const design = readDesignFacts(store, changeId, tree);
  const tasksPath = `openspec/changes/${changeId}/tasks.md`;
  const policy = implementPolicy(config.protectedPaths);
  const ctx = {
    changeId,
    title: state.change.title,
    task: { id: task.id, title: task.title, acRefs: task.acRefs, structureRefs: task.structureRefs },
    sources: [
      ...facts.sources,
      ...(design.text ? [{ path: design.path, text: design.text }] : []),
      { path: tasksPath, text: tree.read(tasksPath)! },
    ],
    decisions: state.questions
      .filter((q) => q.status === 'confirmed')
      .map((q) => ({ id: q.id, question: q.question, answer: q.revisions.at(-1)!.text })),
    verifyCommands: config.verify,
    forbidden: policy.forbidden,
    conventions: readConventions(store.root),
    raise: {
      categories: questionCategories(config),
      questionIds: state.questions.map((q) => q.id),
      taskIds: tasks.tasks.map((t) => t.id),
      defaultTaskIds: [task.id],
    },
  };

  const wt = createWorktree(store.root, base);
  const draft = emptyImplementDraft();
  const reject = (type: string, reason: string, extra: Record<string, unknown> = {}): never => {
    store.append({ type, actor, changeId, payload: { taskId: task.id, base, reason, ...extra } });
    throw new ForgeError('implement_rejected', `任务 ${task.id} 的改动未被接受：${reason}`);
  };
  let ran: { result: AgentRunResult; profile: AgentProfile } | undefined;
  try {
    log(`实现任务 ${task.id}：${task.title}（worktree ${wt}）`);
    ran = await runReadOnly(
      store,
      changeId,
      actor,
      'implementer',
      () => ({
        role: 'implementer',
        systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
        prompt: implementerPrompt(ctx),
        tools: implementerTools(draft, ctx),
        isComplete: () => draft.finished || !!draft.blocked || draft.questions.some((q) => q.severity === 'blocking'),
        reset: () => Object.assign(draft, emptyImplementDraft()),
      }),
      opts,
      { cwd: wt, readOnly: false, pathPolicy: policy },
    );
    const { result, profile } = ran;
    const questionIds = recordRaisedQuestions(store, changeId, agentActor('implementer', result, profile), draft.questions, log);
    const blocking = questionIds.filter((_, i) => draft.questions[i]!.severity === 'blocking');
    if (blocking.length) reject('implement.blocked', `agent 提出阻塞问题 ${blocking.join(', ')}，任务暂停，等人回答后重做`, { questionIds: blocking });
    if (draft.blocked) reject('implement.blocked', `agent 报告阻塞：${draft.blocked}`);
    if (headSha(store.root) !== base) reject('implement.rejected', '实现期间项目 HEAD 发生了变化');

    const files = stageAllChanges(wt, base);
    if (!files.length) reject('implement.rejected', 'agent 没有产生任何改动');
    const violations = checkPathPolicy(files, policy);
    if (violations.length) {
      reject('implement.rejected', `改动越界：${violations.map((v) => `${v.path}（${v.reason}）`).join('；')}`, { files, violations });
    }

    // 引擎勾选任务并提交（任务清单属于 openspec/，agent 无权修改）
    const wtTasks = join(wt, tasksPath);
    writeFileSync(wtTasks, markTaskDone(readFileSync(wtTasks, 'utf8'), task.id));
    git(wt, ['add', tasksPath]);
    const agent = agentActor('implementer', result, profile);
    git(wt, [
      'commit',
      '-q',
      '-m',
      `${task.id}: ${task.title}\n\n${draft.summary ?? ''}\n\nSpecForge-Change: ${changeId}\nSpecForge-Task: ${task.id}\nSpecForge-Agent: ${agent.name}`,
    ]);
    const sha = headSha(wt);

    // G5：引擎亲自确认新测试先红后绿，通过后才合入
    const tdd = checkTdd(store, changeId, actor, { taskId: task.id, base, sha }, log);
    if (tdd.failures.length) {
      reject('implement.rejected', `G5 TDD 门未通过：${tdd.failures.map((c) => c.detail).join('；')}`, { sha, files, tddEvidenceId: tdd.evidence.id });
    }

    git(store.root, ['merge', '--ff-only', '-q', sha]);
    store.append({
      type: 'implement.committed',
      actor: agent,
      changeId,
      payload: { taskId: task.id, base, sha, files, summary: draft.summary, testsAdded: draft.testsAdded, tddEvidenceId: tdd.evidence.id, sessionId: result.sessionId },
    });
    log(`✓ 任务 ${task.id} 已提交 ${sha.slice(0, 7)}（${files.length} 个文件）`);
    for (const f of files) log(`  ${f}`);
    if (draft.summary) log(`总结：${draft.summary}`);
    const after = readTasksFacts(store, changeId)!;
    const stillPaused = pausedTasks(after.tasks.filter((t) => !t.done), store.load(changeId).questions);
    const next = nextTask(after, stillPaused);
    if (next) log(`下一个任务：${next.id} ${next.title}`);
    else if (stillPaused.size) log(`暂停中：${pauseText(stillPaused)}`);
    else log('全部任务已完成，可以 sf advance 进入收尾');
  } catch (e) {
    // agent 运行失败时（例如提问后没有正常结束）也要保留它提出的问题
    if (!ran && draft.questions.length) recordRaisedQuestions(store, changeId, { name: 'implementer', role: 'agent' }, draft.questions, log);
    throw e;
  } finally {
    removeWorktree(store.root, wt);
  }
}
