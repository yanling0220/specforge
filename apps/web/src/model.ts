import type { ForgeEvent, GateEvaluation, GateId, GateStatus, Stage } from '@specforge/shared';
import type { ChangeRow, EvidenceEntry, GatesResponse } from './api.ts';

// 界面的视图模型：纯函数，不依赖 React，便于测试。

export const STAGES: Stage[] = ['analysis', 'spec', 'design', 'tasks', 'implement', 'closing', 'delivered'];

export const STAGE_LABEL: Record<Stage, string> = {
  analysis: '需求分析',
  spec: '规格',
  design: '方案',
  tasks: '任务',
  implement: '实现',
  closing: '收尾',
  delivered: '已交付',
};

export const GATE_LABEL: Record<GateId, string> = {
  G1: 'G1 理解门',
  G2: 'G2 规格门',
  G3: 'G3 方案门',
  G4: 'G4 任务门',
  G5: 'G5 TDD 门',
  G6A: 'G6A 验证门',
  G6B: 'G6B 审查门',
  G6: 'G6 双子门禁',
};

export const GATE_ORDER: GateId[] = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6A', 'G6B', 'G6'];

/** 看板：按阶段分列，列内按最近活动倒序 */
export function boardColumns(changes: ChangeRow[]): { stage: Stage; changes: ChangeRow[] }[] {
  return STAGES.map((stage) => ({
    stage,
    changes: changes.filter((c) => c.stage === stage).sort((a, b) => (b.lastEventSeq ?? 0) - (a.lastEventSeq ?? 0)),
  }));
}

/** 需要人处理的原因（看板红点）；空数组表示不需要 */
export function attentionReasons(c: ChangeRow): string[] {
  const out: string[] = [];
  if (c.escalated) out.push('已升级给人处理');
  if (c.openBlocking) out.push(`${c.openBlocking} 个阻塞问题待回答`);
  else if (c.openQuestions) out.push(`${c.openQuestions} 个问题待处理`);
  if (c.fixRounds && !c.escalated && c.stage === 'implement') out.push(`第 ${c.fixRounds} 轮修复`);
  return out;
}

export type StepState = 'done' | 'current' | 'todo';

export interface PipelineStep {
  stage: Stage;
  label: string;
  state: StepState;
  gate?: GateId;
  /** 出口门禁当前的状态；已经过去的阶段的门禁若不再通过，即"上游失效" */
  gateStatus?: GateStatus;
  invalidated: boolean;
}

export function pipelineSteps(g: GatesResponse): PipelineStep[] {
  const idx = g.pipeline.findIndex((p) => p.stage === g.stage);
  return g.pipeline.map((p, i) => {
    const state: StepState = i < idx ? 'done' : i === idx ? 'current' : 'todo';
    const gateStatus = p.exitGate ? g.gates[p.exitGate]?.status : undefined;
    return {
      stage: p.stage,
      label: STAGE_LABEL[p.stage],
      state,
      gate: p.exitGate,
      gateStatus,
      invalidated: state === 'done' && !!p.exitGate && g.upstreamInvalid.includes(p.exitGate),
    };
  });
}

/** 按固定顺序列出已评估的门禁 */
export function orderedGates(g: GatesResponse): GateEvaluation[] {
  return GATE_ORDER.flatMap((id) => (g.gates[id] ? [g.gates[id]!] : []));
}

/**
 * 门禁对应的证据：
 * - G6A：绑定 commit 上的验证证据（最新在前）
 * - G5：每个任务的 G5 证据（最新在前）
 */
export function evidenceForGate(gate: GateEvaluation, evidence: EvidenceEntry[]): EvidenceEntry[] {
  const latestFirst = [...evidence].sort((a, b) => b.seq - a.seq);
  if (gate.gate === 'G6A') return latestFirst.filter((e) => e.kind === 'verify' && e.sha === gate.boundTo.value);
  if (gate.gate === 'G5') return latestFirst.filter((e) => e.kind === 'tdd');
  return [];
}

const short = (v: unknown) => (typeof v === 'string' ? v.slice(0, 7) : '');
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/** 事件的一句话说明 */
export function eventSummary(e: ForgeEvent): string {
  const p = e.payload as Record<string, any>;
  switch (e.type) {
    case 'change.created':
      return `创建 change：${str(p.title)}（${str(p.tier)} 档）`;
    case 'stage.advanced':
      return `推进：${STAGE_LABEL[p.from as Stage] ?? p.from} → ${STAGE_LABEL[p.to as Stage] ?? p.to}`;
    case 'stage.advance_rejected':
      return `推进被拒绝：${str(p.reason)}`;
    case 'stage.sent_back':
      return `审查不通过，打回实现（第 ${str(p.fixRound?.round)} 轮修复）`;
    case 'change.escalated':
      return `已升级给人：${str(p.reason)}`;
    case 'restatement.set':
      return '需求复述已更新';
    case 'restatement.confirmed':
      return '需求复述已确认';
    case 'question.raised':
      return p.questionIds
        ? `提出问题 ${(p.questionIds as string[]).join(', ')}`
        : `提出问题 ${str(p.questionId)}${p.question ? `：${str(p.question)}` : ''}`;
    case 'question.answered':
      return `${str(p.questionId)} 回答（第 ${str(p.rev)} 版）：${str(p.text)}`;
    case 'question.confirmed':
      return `${str(p.questionId)} 第 ${str(p.rev)} 版由 ${str(p.confirmer?.name)}（${str(p.role)}）确认${p.via ? `，渠道 ${str(p.via)}` : ''}`;
    case 'question.rejected':
      return `${str(p.questionId)} 答案被驳回${p.note ? `：${str(p.note)}` : ''}`;
    case 'question.deferred':
    case 'question.invalidated':
      return `${str(p.questionId)} 已${e.type.endsWith('deferred') ? '推迟' : '作废'}：${str(p.reason)}`;
    case 'dimension.set':
      return `维度「${str(p.dimension)}」→ ${str(p.status)}`;
    case 'assumption.added':
      return `新增假设 ${str(p.id)}：${str(p.text)}`;
    case 'assumption.decided':
      return `假设 ${str(p.assumptionId)} ${p.status === 'accepted' ? '已确认' : '已否决'}`;
    case 'review.recorded':
      return `${p.kind === 'human' ? '开发者签字' : 'agent 审查'}：${p.verdict === 'pass' ? '通过' : '不通过'}（${short(p.sha)}）`;
    case 'evidence.recorded':
      return `验证 ${short(p.sha)}：${(p.steps as { name: string; exitCode: number | null }[]).map((s) => `${s.name} ${s.exitCode === 0 ? '✓' : '✗'}`).join('，')}`;
    case 'tdd.recorded':
      return `G5 ${str(p.taskId)}：${p.passed ? '先红后绿 ✓' : '未通过 ✗'}（${short(p.sha)}）`;
    case 'implement.committed':
      return `${str(p.taskId)} 已提交 ${short(p.sha)}（${(p.files as string[] | undefined)?.length ?? 0} 个文件）`;
    case 'implement.rejected':
    case 'implement.blocked':
      return `${str(p.taskId)} 未被接受：${str(p.reason)}`;
    case 'agent.run':
      return `${str(p.role)} agent ${p.ok ? '完成' : '失败'}（${str(p.backend)} · ${str(p.turns)} 轮）${p.error ? `：${str(p.error)}` : ''}`;
    case 'artifact.generated':
      return `生成 ${str(p.kind)}：${(p.files as { path: string }[] | undefined)?.map((f) => f.path).join(', ') ?? ''}`;
    case 'spec.approved':
    case 'design.approved':
      return `${e.type.startsWith('spec') ? 'spec' : '方案'}已审批（${short(p.hash)}）`;
    case 'analysis.agent_submitted':
      return `需求分析已写入${p.summary ? `：${str(p.summary).slice(0, 80)}` : ''}`;
    default:
      return e.type;
  }
}

/** 事件类别，用于时间线配色与过滤 */
export function eventCategory(type: string): 'stage' | 'question' | 'agent' | 'evidence' | 'review' | 'other' {
  if (type.startsWith('stage.') || type.startsWith('change.')) return 'stage';
  if (type.startsWith('question.') || type.startsWith('restatement.') || type.startsWith('assumption.') || type.startsWith('dimension.') || type.startsWith('analysis.')) return 'question';
  if (type.startsWith('agent.') || type.startsWith('implement.') || type.startsWith('artifact.')) return 'agent';
  if (type.startsWith('evidence.') || type.startsWith('tdd.')) return 'evidence';
  if (type.startsWith('review.') || type.endsWith('.approved')) return 'review';
  return 'other';
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** hash 路由：#/、#/changes/:id、#/changes/:id/evidence/:eid、#/events */
export type Route =
  | { page: 'board' }
  | { page: 'events' }
  | { page: 'change'; id: string; tab: 'gates' | 'timeline' }
  | { page: 'evidence'; id: string; eid: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'events') return { page: 'events' };
  if (parts[0] === 'changes' && parts[1]) {
    if (parts[2] === 'evidence' && parts[3]) return { page: 'evidence', id: parts[1], eid: parts[3] };
    return { page: 'change', id: parts[1], tab: parts[2] === 'timeline' ? 'timeline' : 'gates' };
  }
  return { page: 'board' };
}

export function href(r: Route): string {
  const e = encodeURIComponent;
  switch (r.page) {
    case 'board':
      return '#/';
    case 'events':
      return '#/events';
    case 'change':
      return `#/changes/${e(r.id)}${r.tab === 'timeline' ? '/timeline' : ''}`;
    case 'evidence':
      return `#/changes/${e(r.id)}/evidence/${e(r.eid)}`;
  }
}
