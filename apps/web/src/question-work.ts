import type { HumanRole, QuestionWorkDetail, QuestionWorkStatus } from '@specforge/shared';

export interface QuestionDraft {
  base: string; optionId: string; text: string; supplement: string; reason: string;
  mode: 'free' | 'option'; touched: boolean;
}
export const WORK_LABEL = { answer: '待回答', revise: '待修订', confirm: '待本角色确认', waiting: '等待其他角色' };
export const WORK_ACTION = { answer: '开始回答', revise: '修改答案', confirm: '核对答案', waiting: '查看进度' };
export const roleLabel = (role: string) => ({ dev: '开发', product: '产品', agent: '智能体' })[role] ?? role;
export const rolesLabel = (roles: string[]) => roles.map(roleLabel).join('、');
export function initialQuestionDraft(detail: QuestionWorkDetail): QuestionDraft {
  const revision = detail.question.revisions.at(-1);
  return { base: detail.questionVersion, optionId: revision?.optionId ?? '', text: revision?.text ?? '', supplement: '', reason: '', mode: 'free', touched: false };
}
export const draftPrefix = (api: string) => 'specforge.question-draft:' + encodeURIComponent(api) + ':';
export const draftKey = (api: string, detail: QuestionWorkDetail) => draftPrefix(api)
  + JSON.stringify([detail.draftScope, detail.role, detail.changeId, detail.question.id]);
const TTL = 24 * 60 * 60 * 1000;
function validDraft(value: unknown): value is QuestionDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as QuestionDraft;
  return ['base', 'optionId', 'text', 'supplement', 'reason'].every((key) => typeof (d as unknown as Record<string, unknown>)[key] === 'string')
    && /^[a-f0-9]{64}$/.test(d.base) && (d.mode === 'free' || d.mode === 'option') && typeof d.touched === 'boolean';
}
export function readQuestionDraft(storage: Storage, key: string, now = Date.now()): QuestionDraft | undefined {
  const raw = storage.getItem(key);
  if (!raw) return;
  try {
    const entry = JSON.parse(raw) as { draft?: unknown; at?: number };
    if (validDraft(entry.draft) && typeof entry.at === 'number' && entry.at <= now && now - entry.at < TTL) return entry.draft;
  } catch { /* malformed local data is not an editor input */ }
  storage.removeItem(key);
}
export function saveQuestionDraft(storage: Storage, api: string, key: string, draft: QuestionDraft, now = Date.now()) {
  const raw = JSON.stringify({ draft, at: now });
  if (raw.length > 64 * 1024) throw new Error('草稿超过此标签页的保存上限');
  const prefix = draftPrefix(api);
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k): k is string => !!k && k.startsWith(prefix));
  for (const k of keys) readQuestionDraft(storage, k, now);
  const count = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k) => k?.startsWith(prefix)).length;
  if (!storage.getItem(key) && count >= 20) throw new Error('已保存 20 份草稿，请先提交或放弃旧草稿');
  storage.setItem(key, raw);
}
export function clearQuestionDrafts(api: string, storage: Storage) {
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i));
  for (const key of keys) if (key?.startsWith(draftPrefix(api))) storage.removeItem(key);
}
export const leaveQuestionEvent = 'specforge:leave-question';
export const allowQuestionLeave = () => window.dispatchEvent(new Event(leaveQuestionEvent, { cancelable: true }));

export interface WorkListState { status: QuestionWorkStatus | ''; scroll: number; focus?: string }
const lists = new Map<string, WorkListState>();
export function workListState(api: string, name: string, role: HumanRole): WorkListState {
  const key = JSON.stringify([api, name, role]);
  if (!lists.has(key)) lists.set(key, { status: '', scroll: 0 });
  return lists.get(key)!;
}
