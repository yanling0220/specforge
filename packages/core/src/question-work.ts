import type { AnswerDraftInput, Change, HumanRole, Question, QuestionWorkAction, QuestionWorkStatus } from '@specforge/shared';
import { ForgeError } from './errors.ts';
import { hashOf } from './hash.ts';
import { pendingConfirmations } from './inbox.ts';
import { currentRevision, isResolved, missingRoles } from './questions.ts';

export function questionVersion(project: string, change: Change, question: Question): string {
  return hashOf({ project, changeId: change.id, delivered: change.stage === 'delivered', question });
}

export function questionWorkFacts(change: Change, question: Question, role: HumanRole) {
  const delivered = change.stage === 'delivered';
  const latest = currentRevision(question);
  const pending = question.status === 'drafted' && latest?.state === 'pending';
  const missing = pending ? missingRoles(question, latest) : [];
  const required = question.requiredRoles.includes(role);
  const canConfirm = pendingConfirmations([question]).some((item) => item.role === role);
  const actions: QuestionWorkAction[] = [];
  let status: QuestionWorkStatus | undefined;
  if (!delivered && required && !isResolved(question)) {
    if (question.status === 'open') status = latest?.state === 'rejected' ? 'revise' : 'answer';
    if (pending) status = canConfirm ? 'confirm' : 'waiting';
  }
  if (!delivered && question.status !== 'deferred' && question.status !== 'invalidated') {
    if (required || question.status === 'confirmed') actions.push('submit-answer');
    if (canConfirm) actions.push('confirm', 'reject');
    if (pending && missing.some((r) => r !== 'agent')) actions.push('record');
    if (question.severity === 'minor' && question.status !== 'confirmed') actions.push('defer');
    actions.push('invalidate');
  }
  return { delivered, status, missingRoles: missing, actions };
}

export function composeQuestionAnswer(question: Question, input: AnswerDraftInput) {
  if (input.mode === 'free') return input;
  const option = question.options.find((value) => value.id === input.optionId);
  if (!option) throw new ForgeError('bad_option', `选项 ${input.optionId} 不存在`);
  const supplement = input.supplement?.trim();
  return { ...input, text: supplement ? `${option.text}\n\n${supplement}` : option.text };
}
