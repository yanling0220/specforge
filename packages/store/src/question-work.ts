import { ForgeError, hashOf, questionVersion, questionWorkFacts, resolveIdentity } from '@specforge/core';
import type { Actor, HumanRole, QuestionWorkDetail, QuestionWorkItem, QuestionWorkPage, QuestionWorkStatus, Severity } from '@specforge/shared';
import { readAuditedStates } from './audit.ts';
import { withStoreLock, type Store } from './store.ts';

function workRole(store: Store, actor: Actor): HumanRole {
  const registry = store.users();
  if (!registry) throw new ForgeError('no_registry', '问题工作列表需要启用用户名册并登录');
  const { role } = resolveIdentity(registry, actor);
  if (role !== 'dev' && role !== 'product') throw new ForgeError('bad_role', '问题工作列表仅供人类角色使用');
  return role;
}

const PAGE_SIZE = 50;
const PRIORITY: Record<Severity, number> = { blocking: 0, important: 1, minor: 2 };
const summary = (text: string, limit: number) => text.length > limit ? text.slice(0, limit - 1) + '…' : text;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export const readQuestionWork = withStoreLock(function readQuestionWork(
  store: Store, actor: Actor, filter?: QuestionWorkStatus, cursor?: string, project: string = store.root,
): QuestionWorkPage {
  const role = workRole(store, actor);
  const counts = { answer: 0, revise: 0, confirm: 0, waiting: 0 };
  const items: QuestionWorkItem[] = [];
  const versions: string[] = [];
  for (const { change, questions } of readAuditedStates(store)) {
    if (change.stage === 'delivered') continue;
    for (const q of questions) {
      const { status, missingRoles } = questionWorkFacts(change, q, role);
      if (!status) continue;
      counts[status]++;
      if (filter && status !== filter) continue;
      const r = q.revisions.at(-1);
      versions.push(questionVersion(project, change, q));
      items.push({
        changeId: change.id, changeTitle: summary(change.title, 120), questionId: q.id,
        question: summary(q.question, 280), severity: q.severity, raisedAt: q.raisedAt,
        status, requiredRoles: q.requiredRoles, missingRoles,
        answer: r && { rev: r.rev, text: summary(r.text, 240), rejection: r.rejection && summary(r.rejection.note, 240) },
      });
    }
  }
  items.sort((a, b) => PRIORITY[a.severity] - PRIORITY[b.severity] || compare(a.raisedAt, b.raisedAt)
    || compare(a.changeId, b.changeId) || compare(a.questionId, b.questionId));
  const version = hashOf({ project, role, filter, counts, items, versions });
  let offset = 0;
  if (cursor !== undefined) {
    const parsed = /^([a-f0-9]{64})\.([1-9]\d{0,9})$/.exec(cursor);
    if (!parsed) throw new ForgeError('bad_arg', '无效的问题列表游标');
    offset = Number(parsed[2]);
    if (parsed[1] !== version || offset >= items.length || offset % PAGE_SIZE !== 0) {
      throw new ForgeError('stale_cursor', '问题列表已更新，请从第一页重新读取');
    }
  }
  const next = offset + PAGE_SIZE;
  return { role, counts, items: items.slice(offset, next), nextCursor: next < items.length ? `${version}.${next}` : undefined };
});

export const readQuestionDetail = withStoreLock(function readQuestionDetail(
  store: Store, actor: Actor, changeId: string, questionId: string, draftScope: string, project: string = store.root,
): QuestionWorkDetail {
  const role = workRole(store, actor);
  const state = readAuditedStates(store).find(({ change }) => change.id === changeId);
  const question = state?.questions.find((q) => q.id === questionId);
  if (!state || !question) throw new ForgeError('not_found', `问题 ${questionId} 不存在`);
  return {
    changeId, changeTitle: state.change.title, role, question, draftScope,
    questionVersion: questionVersion(project, state.change, question),
    ...questionWorkFacts(state.change, question, role),
  };
});
