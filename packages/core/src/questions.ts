import type {
  Actor,
  AnswerReference,
  AnswerRevision,
  Confirmation,
  ProjectConfig,
  Question,
  QuestionOption,
  Role,
  Severity,
  Stage,
} from '@specforge/shared';
import { ForgeError } from './errors.ts';
import { hashOf } from './hash.ts';

// 所有函数都返回新的 Question，不修改入参；调用方负责落盘和写事件日志。

export interface NewQuestionInput {
  id: string;
  category: string;
  severity: Severity;
  question: string;
  why?: string;
  evidence?: string;
  nodeId?: string;
  options?: QuestionOption[];
  defaultOptionId?: string;
  dependsOn?: string[];
  raisedAtStage: Stage;
  taskIds?: string[];
}

export function requiredRolesFor(category: string, config: ProjectConfig): Role[] {
  return config.confirmPolicy[category] ?? config.confirmPolicy.default;
}

export function createQuestion(input: NewQuestionInput, config: ProjectConfig, actor: Actor, now: string): Question {
  const options = input.options ?? [];
  if (input.severity === 'blocking' && input.defaultOptionId) {
    throw new ForgeError('blocking_default', '阻塞问题不允许设置默认答案');
  }
  if (input.defaultOptionId && !options.some((o) => o.id === input.defaultOptionId)) {
    throw new ForgeError('bad_option', `默认选项 ${input.defaultOptionId} 不在选项列表中`);
  }
  return {
    id: input.id,
    nodeId: input.nodeId,
    category: input.category,
    severity: input.severity,
    question: input.question,
    why: input.why,
    evidence: input.evidence,
    options,
    defaultOptionId: input.defaultOptionId,
    requiredRoles: requiredRolesFor(input.category, config),
    status: 'open',
    dependsOn: input.dependsOn ?? [],
    raisedAtStage: input.raisedAtStage,
    ...(input.taskIds?.length ? { taskIds: input.taskIds } : {}),
    raisedBy: actor,
    raisedAt: now,
    revisions: [],
  };
}

export function currentRevision(q: Question): AnswerRevision | undefined {
  return q.revisions.at(-1);
}

function revisionForAction(q: Question, expected?: AnswerReference): AnswerRevision | undefined {
  const revision = currentRevision(q);
  if (expected && (revision?.rev !== expected.rev || revision?.hash !== expected.hash)) {
    throw new ForgeError('stale_answer', `${q.id} 的答案已更新，请刷新后重新核对再操作`);
  }
  return revision;
}

/** 当前生效的（已确认的）答案 */
export function effectiveAnswer(q: Question): AnswerRevision | undefined {
  return q.status === 'confirmed' ? currentRevision(q) : undefined;
}

export function isResolved(q: Question): boolean {
  return q.status === 'confirmed' || q.status === 'deferred' || q.status === 'invalidated';
}

export function missingRoles(q: Question, rev = currentRevision(q)): Role[] {
  if (!rev) return [...q.requiredRoles];
  return q.requiredRoles.filter((role) => !rev.confirmations.some((c) => c.role === role));
}

function assertOpenForAnswers(q: Question): void {
  if (q.status === 'invalidated') throw new ForgeError('closed', `${q.id} 已作废，不能再回答`);
}

export interface ProposeInput {
  text: string;
  optionId?: string;
  reason?: string;
  via?: string;
}

/**
 * 起草答案，生成新的修订版本。
 * - 提出者所属角色视为已确认。
 * - 取代已确认的答案时必须填写原因，旧版本标记为 superseded。
 */
export function proposeAnswer(q: Question, input: ProposeInput, actor: Actor, now: string): Question {
  assertOpenForAnswers(q);
  if (!input.text.trim()) throw new ForgeError('empty_answer', '答案不能为空');
  if (input.optionId && !q.options.some((o) => o.id === input.optionId)) {
    throw new ForgeError('bad_option', `选项 ${input.optionId} 不存在`);
  }
  const prev = currentRevision(q);
  if (prev?.state === 'confirmed' && !input.reason?.trim()) {
    throw new ForgeError('reason_required', `${q.id} 已有确认的答案，修改必须填写原因（--reason）`);
  }
  const revisions = q.revisions.map((r) =>
    r.state === 'confirmed' || r.state === 'pending' ? { ...r, state: 'superseded' as const } : r,
  );
  const rev: AnswerRevision = {
    rev: q.revisions.length + 1,
    text: input.text,
    optionId: input.optionId,
    reason: input.reason,
    proposedBy: actor,
    proposedAt: now,
    state: 'pending',
    confirmations: [],
    hash: hashOf({ text: input.text, optionId: input.optionId ?? null }),
  };
  if (q.requiredRoles.includes(actor.role)) {
    rev.confirmations.push({ role: actor.role, actor, at: now, via: input.via });
  }
  return settle({ ...q, revisions: [...revisions, rev], closure: undefined });
}

export interface ConfirmInput {
  /** 代录时填写被代录人；为空表示本人确认 */
  onBehalfOf?: Actor;
  via?: string;
  note?: string;
  expected?: AnswerReference;
}

/** 确认当前修订版本。代录必须写明核对渠道。 */
export function confirmAnswer(q: Question, input: ConfirmInput, actor: Actor, now: string): Question {
  assertOpenForAnswers(q);
  const rev = revisionForAction(q, input.expected);
  if (!rev || rev.state !== 'pending') {
    throw new ForgeError('nothing_to_confirm', `${q.id} 没有待确认的答案`);
  }
  const subject = input.onBehalfOf ?? actor;
  if (input.onBehalfOf && !input.via?.trim()) {
    throw new ForgeError('via_required', '代录确认必须填写核对渠道（--via，例如会议纪要或 IM 链接）');
  }
  if (!q.requiredRoles.includes(subject.role)) {
    throw new ForgeError('role_not_required', `${q.id} 不需要 ${subject.role} 角色确认（需要：${q.requiredRoles.join(', ')}）`);
  }
  if (rev.confirmations.some((c) => c.role === subject.role)) {
    throw new ForgeError('already_confirmed', `${subject.role} 角色已确认过 ${q.id} 的第 ${rev.rev} 版答案`);
  }
  const confirmation: Confirmation = {
    role: subject.role,
    actor: subject,
    at: now,
    via: input.via,
    note: input.note,
    recordedBy: input.onBehalfOf ? actor : undefined,
  };
  const updated = { ...rev, confirmations: [...rev.confirmations, confirmation] };
  return settle({ ...q, revisions: [...q.revisions.slice(0, -1), updated] });
}

/** 驳回当前待确认的答案，问题回到 open */
export function rejectAnswer(q: Question, note: string, actor: Actor, now: string, onBehalfOf?: Actor, expected?: AnswerReference): Question {
  const rev = revisionForAction(q, expected);
  if (!rev || rev.state !== 'pending') throw new ForgeError('nothing_to_reject', `${q.id} 没有待确认的答案`);
  if (!note.trim()) throw new ForgeError('note_required', '驳回必须填写意见');
  const by = onBehalfOf ?? actor;
  const fullNote = onBehalfOf ? `${note}（由 ${actor.name} 代录）` : note;
  const updated: AnswerRevision = { ...rev, state: 'rejected', rejection: { actor: by, at: now, note: fullNote } };
  return { ...q, revisions: [...q.revisions.slice(0, -1), updated], status: 'open' };
}

/**
 * 追加确认角色（只增不减）：分类不当时由人兜底，例如把业务决策升级为需要产品确认。
 * 当前待确认或已确认的答案会重新计算状态：已确认的答案缺少新角色时回到待确认。
 */
export function requireRole(q: Question, role: Role, reason: string): Question {
  if (!reason.trim()) throw new ForgeError('reason_required', '追加确认角色必须填写原因');
  if (q.requiredRoles.includes(role)) throw new ForgeError('already_required', `${q.id} 已经需要 ${role} 确认`);
  const requiredRoles = [...q.requiredRoles, role];
  const rev = currentRevision(q);
  if (!rev || (rev.state !== 'pending' && rev.state !== 'confirmed')) return { ...q, requiredRoles };
  const reopened = { ...rev, state: 'pending' as const };
  return settle({ ...q, requiredRoles, revisions: [...q.revisions.slice(0, -1), reopened] });
}

/** 推迟：只允许 minor 问题 */
export function deferQuestion(q: Question, reason: string, actor: Actor, now: string): Question {
  if (q.severity !== 'minor') throw new ForgeError('cannot_defer', `只有次要问题可以推迟，${q.id} 是 ${q.severity}`);
  if (!reason.trim()) throw new ForgeError('reason_required', '推迟必须填写原因');
  return { ...q, status: 'deferred', closure: { kind: 'deferred', actor, at: now, reason } };
}

/** 作废：问题不再成立（例如依赖问题的答案使其失去意义） */
export function invalidateQuestion(q: Question, reason: string, actor: Actor, now: string): Question {
  if (!reason.trim()) throw new ForgeError('reason_required', '作废必须填写原因');
  return { ...q, status: 'invalidated', closure: { kind: 'invalidated', actor, at: now, reason } };
}

/** 根据当前修订版本的确认情况计算状态 */
function settle(q: Question): Question {
  const rev = currentRevision(q);
  if (!rev || rev.state !== 'pending') return q;
  if (missingRoles(q, rev).length === 0) {
    const confirmed = { ...rev, state: 'confirmed' as const };
    return { ...q, revisions: [...q.revisions.slice(0, -1), confirmed], status: 'confirmed' };
  }
  return { ...q, status: 'drafted' };
}

export function nextQuestionId(questions: Question[]): string {
  const max = questions.reduce((m, q) => Math.max(m, Number(q.id.replace(/^Q-/, '')) || 0), 0);
  return `Q-${max + 1}`;
}
