#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  addAssumption,
  confirmAnswer,
  confirmRestatement,
  createQuestion,
  decideAssumption,
  deferQuestion,
  emptyAnalysis,
  ForgeError,
  invalidateQuestion,
  missingRoles,
  nextQuestionId,
  maxFixRounds,
  nextStage,
  openFixRound,
  pausedTasks,
  resolveFixRound,
  proposeAnswer,
  rejectAnswer,
  requireRole,
  setDimension,
  setRestatement,
  upstreamGates,
  verifyChain,
} from '@specforge/core';
import { git, headSha, repoRoot, runVerification } from '@specforge/runner';
import type {
  AgentBackend,
  Change,
  Role,
  AgentProfile,
  GateEvaluation,
  Question,
  QuestionOption,
  ReviewFinding,
  ReviewRecord,
  Severity,
  Tier,
} from '@specforge/shared';
import { cmdAgentAnalyze, cmdAgentImplement, cmdAgentReview } from './agent-cmds.ts';
import { recordReview } from './review.ts';
import { checkTdd } from './tdd.ts';
import { bindingNow, evaluateAll, factsTree, readTasksFacts, uncommittedSpecChanges } from './engine.ts';
import { defaultConfig, FORGE_DIR, parseActor, Store, type ChangeState } from './store.ts';

const HELP = `SpecForge CLI（第一期）

身份
  sf init                                         在当前 git 仓库初始化 .specforge/
  sf whoami [--set <名字>:<dev|product>]           查看或设置本机身份
  （任何命令都可以加 --as <名字>:<角色> 临时指定身份）

change
  sf change new <id> --title <标题> [--tier S|M|L]
  sf change list
  sf status <id>                                  阶段 + 全部门禁的实时评估
  sf advance <id>                                 推进到下一阶段（门禁不通过会被拒绝）

需求分析
  sf restate <id> --text <复述>                    设置需求复述
  sf restate <id> --confirm [--via <渠道>]         确认需求复述
  sf assume add <id> --text <假设>
  sf assume decide <id> <A-n> --accept|--reject [--note <说明>]
  sf dim set <id> <维度> covered|na|question [--reason <原因>] [--questions Q-1,Q-2]
  sf dim list <id>

问题节点
  sf q add <id> --q <问题> --severity blocking|important|minor --category <分类>
               [--why <原因>] [--evidence <依据>] [--node <节点>] [--depends Q-1,Q-2]
               [--tasks T-1,T-2]                  关联任务：阻塞问题未解决时暂停这些任务（不填则暂停全部）
               [--option "A=文本|影响"]... [--recommend A] [--default A]
  sf q list <id>
  sf q show <id> <Q-n>                            完整修订与核对历史
  sf q answer <id> <Q-n> --text <答案> [--option A] [--reason <修改原因>] [--via <渠道>]
  sf q confirm <id> <Q-n> [--on-behalf <名字>:<角色> --via <渠道>] [--note <说明>]
  sf q reject <id> <Q-n> --note <意见> [--on-behalf <名字>:<角色>]
  sf q defer <id> <Q-n> --reason <原因>
  sf q invalidate <id> <Q-n> --reason <原因>
  sf q require <id> <Q-n> --role product --reason <原因>   追加确认角色（只增不减）

规格与收尾
  sf spec approve <id> [--note <说明>]            审批当前版本的 spec（绑定内容哈希）
  sf design approve <id> [--note <说明>]          审批当前版本的方案（L 档或涉及受保护路径时需要）
    design.md 约定：正文引用每个 AC；「## 结构变更」逐条 - [S-n] …，无变更写 - 无：<原因>
    tasks.md 约定：- [ ] T-1 标题（AC-1, S-1）依赖 T-0；勾选进度不影响 G4
  sf tdd <id> <T-n> --base <sha> [--sha <sha>]     G5：手工实现的任务，确认 base..sha 新增的测试先红后绿（sha 默认 HEAD）
    config.tdd：{ "command": "node --test {files}", "setup": "npm ci" }（{files} 为新增/修改的测试文件）
  sf verify <id>                                  在干净 worktree 中执行验证并记录证据
  sf review <id> --kind agent|human --verdict pass|fail
               [--reviewer <名字>] [--coverage AC-1,AC-2] [--file <审查报告.json>] [--note <说明>]

AI agent
  sf agent analyze <id>                           需求分析 agent：复述、分解树、假设、维度、问题节点
  sf agent implement <id> [--task T-n]            实现 agent：在独立 worktree 中实现下一个（或指定）任务，
                                                  越界改动或 G5（先红后绿）不通过则整体丢弃，通过后由引擎提交并 fast-forward 合入
  sf agent review <id>                            独立审查 agent（G6 6B），针对当前 HEAD
               [--backend claude|deepseek|codex|openai-compatible] [--provider deepseek|ollama]
               [--model <模型>] [--effort low|medium|high|xhigh|max] [--budget <美元上限>] [--verbose]

审计
  sf log [<id>]                                   事件时间线
  sf log verify                                   校验哈希链与带外修改
  sf log ack <id> --reason <说明>                  确认带外修改
`;

const { values: opts, positionals: args } = parseArgs({
  allowPositionals: true,
  options: {
    as: { type: 'string' },
    set: { type: 'string' },
    title: { type: 'string' },
    tier: { type: 'string' },
    text: { type: 'string' },
    confirm: { type: 'boolean' },
    via: { type: 'string' },
    note: { type: 'string' },
    reason: { type: 'string' },
    accept: { type: 'boolean' },
    reject: { type: 'boolean' },
    questions: { type: 'string' },
    q: { type: 'string' },
    severity: { type: 'string' },
    category: { type: 'string' },
    why: { type: 'string' },
    evidence: { type: 'string' },
    node: { type: 'string' },
    depends: { type: 'string' },
    option: { type: 'string', multiple: true },
    recommend: { type: 'string' },
    default: { type: 'string' },
    'on-behalf': { type: 'string' },
    kind: { type: 'string' },
    role: { type: 'string' },
    verdict: { type: 'string' },
    reviewer: { type: 'string' },
    coverage: { type: 'string' },
    file: { type: 'string' },
    backend: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    budget: { type: 'string' },
    verbose: { type: 'boolean', short: 'v' },
    task: { type: 'string' },
    tasks: { type: 'string' },
    base: { type: 'string' },
    sha: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const now = () => new Date().toISOString();
const list = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === '') throw new ForgeError('missing_arg', `缺少参数：${what}`);
  return value;
}

function findQuestion(state: ChangeState, qid: string): Question {
  const q = state.questions.find((x) => x.id === qid);
  if (!q) throw new ForgeError('not_found', `问题 ${qid} 不存在`);
  return q;
}

function replaceQuestion(state: ChangeState, q: Question): ChangeState {
  return { ...state, questions: state.questions.map((x) => (x.id === q.id ? q : x)) };
}

// ---------------- 输出 ----------------

const STATUS_ICON = { passed: '✅', failed: '❌', unverified: '⚪' } as const;

function printGate(ev: GateEvaluation): void {
  console.log(`${STATUS_ICON[ev.status]} ${ev.gate}  绑定 ${ev.boundTo.kind === 'commit' ? 'commit' : '内容'} ${ev.boundTo.value.slice(0, 12)}`);
  for (const c of ev.checks) {
    console.log(`   ${c.passed ? '✓' : '✗'} ${c.label}${c.detail ? `\n       ${c.detail}` : ''}`);
  }
}

const Q_STATUS: Record<Question['status'], string> = {
  open: '待回答',
  drafted: '待确认',
  confirmed: '已确认',
  deferred: '已推迟',
  invalidated: '已作废',
};
const SEVERITY: Record<Severity, string> = { blocking: '🔴 阻塞', important: '🟠 重要', minor: '🟢 次要' };

function printQuestionLine(q: Question): void {
  const rev = q.revisions.at(-1);
  const waiting = q.status === 'drafted' ? `，待 ${missingRoles(q).join('、')} 确认` : '';
  console.log(`${q.id}  ${SEVERITY[q.severity]}  [${q.category}]  ${Q_STATUS[q.status]}${waiting}`);
  console.log(`      ${q.question}`);
  if (rev && rev.state !== 'rejected') console.log(`      答（第 ${rev.rev} 版）：${rev.text}`);
}

function printQuestionHistory(q: Question): void {
  printQuestionLine(q);
  if (q.why) console.log(`      为什么问：${q.why}`);
  if (q.evidence) console.log(`      依据：${q.evidence}`);
  for (const o of q.options) {
    console.log(`      ${o.id}. ${o.text}${o.impact ? `（${o.impact}）` : ''}${o.recommended ? ' ⭐推荐' : ''}${q.defaultOptionId === o.id ? ' [默认]' : ''}`);
  }
  console.log(`      确认角色：${q.requiredRoles.join(' + ')}；提出：${q.raisedBy.name}(${q.raisedBy.role}) @ ${q.raisedAt}`);
  for (const r of q.revisions) {
    console.log(`  ── 第 ${r.rev} 版 [${r.state}]  hash ${r.hash.slice(0, 12)}`);
    console.log(`     ${r.text}${r.optionId ? `（选项 ${r.optionId}）` : ''}`);
    if (r.reason) console.log(`     修改原因：${r.reason}`);
    console.log(`     起草：${r.proposedBy.name}(${r.proposedBy.role}) @ ${r.proposedAt}`);
    for (const c of r.confirmations) {
      const proxy = c.recordedBy ? `，由 ${c.recordedBy.name} 代录` : '';
      console.log(`     确认：${c.role} · ${c.actor.name} @ ${c.at}${c.via ? ` · 渠道 ${c.via}` : ''}${proxy}${c.note ? ` · ${c.note}` : ''}`);
    }
    if (r.rejection) console.log(`     驳回：${r.rejection.actor.name} @ ${r.rejection.at} · ${r.rejection.note}`);
  }
  if (q.closure) console.log(`  ── ${q.closure.kind === 'deferred' ? '推迟' : '作废'}：${q.closure.actor.name} @ ${q.closure.at} · ${q.closure.reason}`);
}

// ---------------- 命令 ----------------

function cmdInit(): void {
  const root = repoRoot(process.cwd());
  const store = new Store(root);
  if (existsSync(store.path('config.json'))) throw new ForgeError('exists', `${FORGE_DIR}/ 已存在`);
  mkdirSync(store.path('changes'), { recursive: true });
  writeFileSync(store.path('config.json'), JSON.stringify(defaultConfig(), null, 2) + '\n');
  const gi = join(root, '.gitignore');
  const line = `${FORGE_DIR}/identity.local.json`;
  const content = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!content.split('\n').includes(line)) writeFileSync(gi, content + (content && !content.endsWith('\n') ? '\n' : '') + line + '\n');
  console.log(`已初始化 ${root}/${FORGE_DIR}/`);
  console.log('下一步：编辑 .specforge/config.json 中的 verify 步骤，然后运行 sf whoami --set <名字>:dev');
}

function cmdStatus(store: Store, id: string): void {
  const state = store.load(id);
  const { change } = state;
  console.log(`${change.id} · ${change.title} · ${change.tier} 档 · 当前阶段：${change.stage}`);
  const oob = store.outOfBand(id, state);
  if (oob) console.log(`⚠️  状态文件被绕过引擎修改（${oob}）`);
  const evals = evaluateAll(store, state);
  const tree = factsTree(store, state);
  const pending = tree.kind === 'commit' ? uncommittedSpecChanges(store, id) : [];
  console.log(`门禁按${tree.kind === 'commit' ? ` HEAD（${tree.sha!.slice(0, 7)}）` : '工作区'}中的 OpenSpec 文件评估`);
  if (pending.length) console.log(`⚠️  以下 OpenSpec 改动尚未提交，不参与评估：${pending.join(', ')}`);
  const upstream = upstreamGates(change.stage, change.tier).filter((g) => evals[g]?.status !== 'passed');
  if (upstream.length) console.log(`⚠️  上游门禁已失效：${upstream.join(', ')}（需要重新满足后才能继续推进）`);
  console.log();
  printFixState(change, maxFixRounds(store.config()));
  if (change.stage === 'implement') {
    const tasks = readTasksFacts(store, id, tree);
    const paused = tasks ? pausedTasks(tasks.tasks.filter((t) => !t.done), state.questions) : new Map<string, string[]>();
    if (paused.size) console.log(`⏸  暂停的任务：${[...paused].map(([t, qs]) => `${t}（等待 ${qs.join(', ')}）`).join('、')}`);
  }
  for (const g of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6A', 'G6B', 'G6'] as const) {
    const ev = evals[g];
    if (ev) printGate(ev);
  }
}

function printFixState(change: Change, max: number): void {
  if (change.escalation) console.log(`⚠️  已升级给人：${change.escalation.reason}（${change.escalation.at}）`);
  const open = openFixRound(change);
  if (!open) return;
  console.log(`↩️  第 ${open.round}/${max} 轮修复进行中（${open.source === 'agent' ? 'agent 审查' : '开发者'}打回 ${open.sha.slice(0, 7)}）：`);
  for (const f of open.findings) console.log(`     ${f.anchor ? `[${f.anchor}] ` : ''}${f.kind ? `(${f.kind}) ` : ''}${f.text}`);
  if (!open.findings.length && open.note) console.log(`     ${open.note}`);
}

function cmdAdvance(store: Store, id: string): void {
  const actor = store.identity(opts.as);
  const state = store.load(id);
  const evals = evaluateAll(store, state);
  let to;
  let change = state.change;
  try {
    to = nextStage(state.change.stage, state.change.tier, evals);
    if (state.change.stage === 'implement') change = resolveFixRound(state.change, headSha(store.root));
  } catch (e) {
    store.append({ type: 'stage.advance_rejected', actor, changeId: id, payload: { from: state.change.stage, reason: (e as Error).message } });
    throw e;
  }
  store.mutate(
    id,
    actor,
    'stage.advanced',
    (s) => ({ ...s, change: { ...change, stage: to } }),
    () => ({
      from: state.change.stage,
      to,
      ...(change !== state.change ? { fixRoundResolved: change.fixRounds!.at(-1) } : {}),
      gates: Object.fromEntries(Object.entries(evals).map(([g, ev]) => [g, { status: ev.status, boundTo: ev.boundTo.value }])),
    }),
  );
  console.log(`✅ ${state.change.stage} → ${to}`);
}

function parseOption(raw: string): QuestionOption {
  const eq = raw.indexOf('=');
  if (eq < 1) throw new ForgeError('bad_option', `选项格式应为 "A=文本|影响"，收到「${raw}」`);
  const [text, impact] = raw.slice(eq + 1).split('|');
  return { id: raw.slice(0, eq).trim(), text: text!.trim(), impact: impact?.trim() };
}

function cmdQuestion(store: Store, sub: string, id: string, qid?: string): void {
  if (sub === 'list') {
    const qs = store.load(id).questions;
    if (!qs.length) console.log('（暂无问题）');
    qs.forEach(printQuestionLine);
    return;
  }
  if (sub === 'show') {
    printQuestionHistory(findQuestion(store.load(id), need(qid, '<Q-n>')));
    return;
  }

  const actor = store.identity(opts.as);
  const config = store.config();

  if (sub === 'add') {
    const severity = need(opts.severity, '--severity') as Severity;
    if (!['blocking', 'important', 'minor'].includes(severity)) throw new ForgeError('bad_arg', '--severity 只能是 blocking|important|minor');
    const options = (opts.option ?? []).map(parseOption).map((o) => ({ ...o, recommended: o.id === opts.recommend || undefined }));
    let created: Question | undefined;
    store.mutate(
      id,
      actor,
      'question.raised',
      (s) => {
        created = createQuestion(
          {
            id: nextQuestionId(s.questions),
            question: need(opts.q, '--q'),
            category: need(opts.category, '--category'),
            severity,
            why: opts.why,
            evidence: opts.evidence,
            nodeId: opts.node,
            dependsOn: list(opts.depends),
            taskIds: list(opts.tasks),
            options,
            defaultOptionId: opts.default,
            raisedAtStage: s.change.stage,
          },
          config,
          actor,
          now(),
        );
        return { ...s, questions: [...s.questions, created] };
      },
      () => ({ questionId: created!.id, severity, category: created!.category, question: created!.question, requiredRoles: created!.requiredRoles }),
    );
    console.log(`已创建 ${created!.id}（需要 ${created!.requiredRoles.join(' + ')} 确认）`);
    return;
  }

  const target = need(qid, '<Q-n>');
  const onBehalfOf = opts['on-behalf'] ? parseActor(opts['on-behalf']) : undefined;
  const ops: Record<string, { type: string; apply: (q: Question) => Question; payload: (q: Question) => Record<string, unknown> }> = {
    answer: {
      type: 'question.answered',
      apply: (q) => proposeAnswer(q, { text: need(opts.text, '--text'), optionId: opts.option?.[0], reason: opts.reason, via: opts.via }, actor, now()),
      payload: (q) => {
        const r = q.revisions.at(-1)!;
        return { questionId: q.id, rev: r.rev, answerHash: r.hash, text: r.text, optionId: r.optionId, reason: r.reason, status: q.status };
      },
    },
    confirm: {
      type: 'question.confirmed',
      apply: (q) => confirmAnswer(q, { onBehalfOf, via: opts.via, note: opts.note }, actor, now()),
      payload: (q) => {
        const r = q.revisions.at(-1)!;
        const c = r.confirmations.at(-1)!;
        return { questionId: q.id, rev: r.rev, answerHash: r.hash, role: c.role, confirmer: c.actor, recordedBy: c.recordedBy, via: c.via, note: c.note, status: q.status };
      },
    },
    reject: {
      type: 'question.rejected',
      apply: (q) => rejectAnswer(q, need(opts.note, '--note'), actor, now(), onBehalfOf),
      payload: (q) => ({ questionId: q.id, rev: q.revisions.at(-1)!.rev, note: q.revisions.at(-1)!.rejection!.note, by: q.revisions.at(-1)!.rejection!.actor }),
    },
    defer: {
      type: 'question.deferred',
      apply: (q) => deferQuestion(q, need(opts.reason, '--reason'), actor, now()),
      payload: (q) => ({ questionId: q.id, reason: q.closure!.reason }),
    },
    require: {
      type: 'question.role_required',
      apply: (q) => {
        const role = need(opts.role, '--role') as Role;
        if (!['dev', 'product'].includes(role)) throw new ForgeError('bad_arg', '--role 只能是 dev|product');
        return requireRole(q, role, need(opts.reason, '--reason'));
      },
      payload: (q) => ({ questionId: q.id, role: opts.role, reason: opts.reason, requiredRoles: q.requiredRoles, status: q.status }),
    },
    invalidate: {
      type: 'question.invalidated',
      apply: (q) => invalidateQuestion(q, need(opts.reason, '--reason'), actor, now()),
      payload: (q) => ({ questionId: q.id, reason: q.closure!.reason }),
    },
  };
  const op = ops[sub];
  if (!op) throw new ForgeError('bad_cmd', `未知命令 sf q ${sub}`);
  let updated: Question | undefined;
  store.mutate(
    id,
    actor,
    op.type,
    (s) => {
      updated = op.apply(findQuestion(s, target));
      return replaceQuestion(s, updated);
    },
    () => op.payload(updated!),
  );
  printQuestionLine(updated!);
}

function cmdReview(store: Store, id: string): void {
  const actor = store.identity(opts.as);
  const kind = need(opts.kind, '--kind') as ReviewRecord['kind'];
  const verdict = need(opts.verdict, '--verdict') as ReviewRecord['verdict'];
  if (!['agent', 'human'].includes(kind)) throw new ForgeError('bad_arg', '--kind 只能是 agent|human');
  if (!['pass', 'fail'].includes(verdict)) throw new ForgeError('bad_arg', '--verdict 只能是 pass|fail');
  if (kind === 'human' && actor.role !== 'dev') throw new ForgeError('bad_role', '开发者签字必须由 dev 角色完成');
  const report = opts.file ? (JSON.parse(readFileSync(opts.file, 'utf8')) as { coverage?: string[]; findings?: ReviewFinding[] }) : {};
  const sha = headSha(store.root);
  const record: ReviewRecord = {
    kind,
    sha,
    verdict,
    reviewer: kind === 'agent' ? { name: opts.reviewer ?? 'review-agent', role: 'agent' } : actor,
    at: now(),
    coverage: report.coverage ?? list(opts.coverage),
    findings: report.findings ?? [],
    note: opts.note,
  };
  console.log(`已记录 ${kind === 'agent' ? 'agent 审查' : '开发者签字'}：${verdict}（commit ${sha.slice(0, 7)}）`);
  recordReview(store, id, actor, record, {}, console.log);
}

function cmdLog(store: Store, sub?: string, id?: string): void {
  if (sub === 'verify') {
    const events = store.events();
    const problems = verifyChain(events);
    problems.forEach((p) => console.log(`❌ 事件 #${p.seq}：${p.problem}`));
    let oob = 0;
    for (const c of store.listChanges()) {
      const msg = store.outOfBand(c);
      if (msg) {
        oob++;
        console.log(`❌ ${c}：状态文件被绕过引擎修改（${msg}）`);
      }
    }
    if (!problems.length && !oob) console.log(`✅ 哈希链完整（${events.length} 条事件），所有 change 状态与日志一致`);
    if (problems.length || oob) process.exitCode = 1;
    return;
  }
  if (sub === 'ack') {
    const changeId = need(id, '<id>');
    store.acknowledgeOutOfBand(changeId, store.identity(opts.as), need(opts.reason, '--reason'));
    console.log(`已记录对 ${changeId} 带外修改的确认`);
    return;
  }
  const filter = sub;
  for (const e of store.events().filter((x) => !filter || x.changeId === filter)) {
    const brief = JSON.stringify(e.payload);
    console.log(`#${e.seq} ${e.at} ${e.actor.name}(${e.actor.role}) ${e.type}${e.changeId ? ` [${e.changeId}]` : ''}`);
    console.log(`    ${brief.length > 160 ? brief.slice(0, 157) + '...' : brief}`);
  }
}

function agentOverride(): Partial<AgentProfile> {
  const effort = opts.effort as AgentProfile['effort'];
  if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new ForgeError('bad_arg', '--effort 只能是 low|medium|high|xhigh|max');
  const budget = opts.budget ? Number(opts.budget) : undefined;
  if (budget !== undefined && !(budget > 0)) throw new ForgeError('bad_arg', '--budget 必须是正数（美元）');
  const backends: AgentBackend[] = ['claude', 'deepseek', 'codex', 'openai-compatible'];
  if (opts.backend && !backends.includes(opts.backend as AgentBackend)) throw new ForgeError('bad_arg', `--backend 只能是 ${backends.join('|')}`);
  return { backend: opts.backend as AgentBackend | undefined, provider: opts.provider, model: opts.model, effort, maxBudgetUsd: budget };
}

async function main(): Promise<void> {
  const [cmd, sub, a1, a2] = args;
  if (!cmd || opts.help) {
    console.log(HELP);
    return;
  }
  if (cmd === 'init') return cmdInit();

  const store = Store.find(process.cwd());

  switch (cmd) {
    case 'whoami': {
      if (opts.set) {
        store.setIdentity(parseActor(opts.set));
        console.log(`身份已设置为 ${opts.set}（仅本机，不提交）`);
      } else {
        const me = store.identity(opts.as);
        console.log(`${me.name}:${me.role}`);
      }
      return;
    }
    case 'change': {
      if (sub === 'list') {
        for (const id of store.listChanges()) {
          const { change } = store.load(id);
          console.log(`${id}  ${change.tier}  ${change.stage}  ${change.title}`);
        }
        return;
      }
      if (sub !== 'new') throw new ForgeError('bad_cmd', `未知命令 sf change ${sub ?? ''}`);
      const id = need(a1, '<id>');
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new ForgeError('bad_id', 'change id 只能包含小写字母、数字和连字符（与 OpenSpec 一致）');
      const tier = (opts.tier ?? 'M') as Tier;
      if (!['S', 'M', 'L'].includes(tier)) throw new ForgeError('bad_arg', '--tier 只能是 S|M|L');
      const actor = store.identity(opts.as);
      store.create(
        {
          change: { id, title: need(opts.title, '--title'), tier, stage: 'analysis', baseSha: headSha(store.root), createdAt: now(), createdBy: actor },
          analysis: emptyAnalysis(store.config()),
          questions: [],
          reviews: [],
          approvals: [],
        },
        actor,
      );
      const osDir = store.openspecChangeDir(id);
      mkdirSync(join(osDir, 'specs'), { recursive: true });
      if (!existsSync(join(osDir, 'proposal.md'))) {
        writeFileSync(join(osDir, 'proposal.md'), `# ${opts.title}\n\n## Why\n\n## What Changes\n\n## 范围外\n`);
      }
      console.log(`已创建 change ${id}（${tier} 档），OpenSpec 目录：openspec/changes/${id}/`);
      return;
    }
    case 'status':
      return cmdStatus(store, need(sub, '<id>'));
    case 'advance':
      return cmdAdvance(store, need(sub, '<id>'));
    case 'restate': {
      const id = need(sub, '<id>');
      const actor = store.identity(opts.as);
      if (opts.confirm) {
        store.mutate(id, actor, 'restatement.confirmed', (s) => ({ ...s, analysis: confirmRestatement(s.analysis, actor, now(), opts.via) }), (s) => ({ hash: s.analysis.restatement!.hash, via: opts.via }));
        console.log('需求复述已确认');
      } else {
        store.mutate(id, actor, 'restatement.set', (s) => ({ ...s, analysis: setRestatement(s.analysis, need(opts.text, '--text')) }), (s) => ({ text: s.analysis.restatement!.text, hash: s.analysis.restatement!.hash }));
        console.log('需求复述已更新（需要重新确认）');
      }
      return;
    }
    case 'assume': {
      const id = need(a1, '<id>');
      const actor = store.identity(opts.as);
      if (sub === 'add') {
        const next = store.mutate(id, actor, 'assumption.added', (s) => ({ ...s, analysis: addAssumption(s.analysis, need(opts.text, '--text')) }), (s) => ({ ...s.analysis.assumptions.at(-1)! }));
        console.log(`已添加 ${next.analysis.assumptions.at(-1)!.id}`);
      } else if (sub === 'decide') {
        const aid = need(a2, '<A-n>');
        if (opts.accept === opts.reject) throw new ForgeError('bad_arg', '需要且只能指定 --accept 或 --reject 之一');
        const status = opts.accept ? 'accepted' : 'rejected';
        store.mutate(id, actor, 'assumption.decided', (s) => ({ ...s, analysis: decideAssumption(s.analysis, aid, status, actor, now(), opts.note) }), () => ({ assumptionId: aid, status, note: opts.note }));
        console.log(`${aid}：${status === 'accepted' ? '已确认' : '已否决'}`);
      } else throw new ForgeError('bad_cmd', `未知命令 sf assume ${sub ?? ''}`);
      return;
    }
    case 'dim': {
      const id = need(a1, '<id>');
      if (sub === 'list') {
        for (const d of store.load(id).analysis.dimensions) {
          console.log(`${d.status.padEnd(9)} ${d.dimension}${d.reason ? ` · ${d.reason}` : ''}${d.questionIds?.length ? ` · ${d.questionIds.join(',')}` : ''}`);
        }
        return;
      }
      if (sub !== 'set') throw new ForgeError('bad_cmd', `未知命令 sf dim ${sub ?? ''}`);
      const dimension = need(a2, '<维度>');
      const status = need(args[4], 'covered|na|question') as 'covered' | 'na' | 'question';
      if (!['covered', 'na', 'question'].includes(status)) throw new ForgeError('bad_arg', '状态只能是 covered|na|question');
      const actor = store.identity(opts.as);
      store.mutate(id, actor, 'dimension.set', (s) => ({ ...s, analysis: setDimension(s.analysis, dimension, status, { reason: opts.reason, questionIds: list(opts.questions) }) }), () => ({ dimension, status, reason: opts.reason, questionIds: list(opts.questions) }));
      console.log(`「${dimension}」→ ${status}`);
      return;
    }
    case 'q':
      return cmdQuestion(store, need(sub, '子命令'), need(a1, '<id>'), a2);
    case 'spec':
    case 'design': {
      if (sub !== 'approve') throw new ForgeError('bad_cmd', `未知命令 sf ${cmd} ${sub ?? ''}`);
      const id = need(a1, '<id>');
      const actor = store.identity(opts.as);
      if (actor.role !== 'dev') throw new ForgeError('bad_role', `${cmd} 审批需要 dev 角色`);
      const hash = bindingNow(store, store.load(id), cmd === 'spec' ? 'G2' : 'G3');
      if (!hash) throw new ForgeError('no_target', `S 档没有 ${cmd} 审批`);
      store.mutate(id, actor, `${cmd}.approved`, (s) => ({ ...s, approvals: [...s.approvals, { target: cmd, hash, actor, at: now(), note: opts.note }] }), () => ({ hash, note: opts.note }));
      console.log(`已审批当前 ${cmd}（hash ${hash.slice(0, 12)}）；内容或上游再有改动，审批即失效`);
      return;
    }
    case 'verify': {
      const id = need(sub, '<id>');
      const actor = store.identity(opts.as);
      store.load(id);
      const config = store.config();
      const sha = headSha(store.root);
      console.log(`在干净 worktree 中验证 commit ${sha.slice(0, 7)}…`);
      const ev = runVerification({
        repo: store.root,
        steps: config.verify,
        sha,
        onStep: (s) => console.log(`  ${s.exitCode === 0 ? '✓' : '✗'} ${s.name}（${s.durationMs}ms，退出码 ${s.timedOut ? '超时' : s.exitCode}）`),
      });
      if (ev.mainTreeDirty) console.log('  ⚠️ 工作区有未提交的改动；它们不在本次验证范围内');
      const file = store.saveEvidence(id, ev, actor);
      console.log(`证据已记录：${store.rel(file)}`);
      return;
    }
    case 'tdd': {
      const id = need(sub, '<id>');
      const taskId = need(a1, '<T-n>');
      const actor = store.identity(opts.as);
      store.load(id);
      if (!readTasksFacts(store, id)?.tasks.some((t) => t.id === taskId)) throw new ForgeError('not_found', `任务 ${taskId} 不在 tasks.md 中`);
      const resolve = (ref: string) => {
        try {
          return git(store.root, ['rev-parse', '--verify', `${ref}^{commit}`]);
        } catch {
          throw new ForgeError('bad_ref', `找不到 commit ${ref}`);
        }
      };
      const base = resolve(need(opts.base, '--base'));
      const sha = resolve(opts.sha ?? 'HEAD');
      const { evidence, failures } = checkTdd(store, id, actor, { taskId, base, sha }, console.log);
      if (failures.length) throw new ForgeError('tdd_failed', `G5 未通过（证据 ${evidence.id}）：${failures.map((c) => c.detail).join('；')}`);
      console.log(`✓ ${taskId} 先红后绿已确认（${base.slice(0, 7)}..${sha.slice(0, 7)}，证据 ${evidence.id}）`);
      return;
    }
    case 'review':
      return cmdReview(store, need(sub, '<id>'));
    case 'log':
      return cmdLog(store, sub, a1);
    case 'agent': {
      const id = need(a1, '<id>');
      const actor = store.identity(opts.as);
      const agentOpts = { override: agentOverride(), verbose: !!opts.verbose };
      if (sub === 'analyze') return cmdAgentAnalyze(store, id, actor, agentOpts);
      if (sub === 'review') return cmdAgentReview(store, id, actor, agentOpts);
      if (sub === 'implement') return cmdAgentImplement(store, id, actor, { ...agentOpts, taskId: opts.task });
      throw new ForgeError('bad_cmd', `未知命令 sf agent ${sub ?? ''}`);
    }
    default:
      throw new ForgeError('bad_cmd', `未知命令 ${cmd}，运行 sf --help 查看用法`);
  }
}

main().catch((e: unknown) => {
  if (e instanceof ForgeError) {
    console.error(`⛔ ${e.message}`);
    process.exitCode = 1;
  } else {
    throw e;
  }
});
