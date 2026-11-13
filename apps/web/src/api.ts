import type {
  Actor,
  ArtifactComment,
  ArtifactTarget,
  Analysis,
  Approval,
  Change,
  ForgeEvent,
  GateEvaluation,
  GateId,
  Question,
  ReviewFinding,
  ReviewRecord,
  Role,
  Stage,
  TaskClaim,
  TddEvidence,
  VerificationEvidence,
} from '@specforge/shared';

// server（apps/server）只读接口的类型与请求函数

export interface ChangeRow {
  id: string;
  title: string;
  tier: string;
  stage: Stage;
  createdAt: string;
  createdBy: string;
  openQuestions: number;
  openBlocking: number;
  fixRounds: number;
  escalated: boolean;
  lastEventSeq: number | null;
  lastEventAt: string | null;
}

export interface ChangeDetail {
  change: Change;
  analysis: Analysis;
  questions: Question[];
  reviews: ReviewRecord[];
  approvals: Approval[];
  outOfBand: string | null;
  factsSource: { kind: 'worktree' } | { kind: 'commit'; sha: string };
  uncommittedSpecChanges: string[];
  restatementConfirmed: boolean;
  /** 问题编号 → 是否已解决、当前版本还缺哪些角色确认 */
  questionProgress: Record<string, { resolved: boolean; missingRoles: Role[] }>;
  /** 任务编号 → 导致暂停的问题编号 */
  pausedTasks: Record<string, string[]>;
  tasks: { id: string; title: string; done: boolean; acRefs: string[]; dependsOn: string[] }[];
  /** 当前有效的接管：任务编号 → 接管记录 */
  claims: Record<string, TaskClaim>;
  comments?: ArtifactComment[];
}

export interface GatesResponse {
  stage: Stage;
  pipeline: { stage: Stage; exitGate?: GateId }[];
  gates: Partial<Record<GateId, GateEvaluation>>;
  upstreamInvalid: GateId[];
}

export type CommentAnchor = { state: 'exact' | 'moved'; line: number } | { state: 'outdated' };

export interface ArtifactView {
  path: string;
  target: ArtifactTarget;
  text: string;
  comments: (ArtifactComment & { anchor: CommentAnchor })[];
}

export interface EvidenceEntry {
  id: string;
  kind: 'verify' | 'tdd';
  sha: string;
  taskId?: string;
  passed: boolean;
  seq: number;
  at: string;
  actor: Actor;
  hashOk: boolean;
}

export interface EvidenceDetail {
  entry: EvidenceEntry;
  content: VerificationEvidence | TddEvidence;
}

export interface ChainStatus {
  ok: boolean;
  events: number;
  chainProblems: { seq: number; problem: string }[];
  outOfBand: { changeId: string; problem: string }[];
}

export const UNAUTHORIZED_EVENT = 'specforge:unauthorized';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface SessionUser {
  name: string;
  roles: Role[];
  admin: boolean;
}

async function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!res.ok) {
    // 会话过期、用户被停用或令牌被重置：通知界面回到登录页
    if (res.status === 401 && body.error?.code === 'unauthorized') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, body.error?.code ?? 'http', body.error?.message ?? `请求失败：${res.status}`);
  }
  return body as T;
}

const enc = encodeURIComponent;

export type QuestionAction = 'answer' | 'confirm' | 'reject' | 'defer' | 'invalidate';

function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
const PAGE = 1000;

export const api = {
  changes: () => get<{ changes: ChangeRow[] }>('/api/changes').then((r) => r.changes),
  change: (id: string) => get<ChangeDetail>(`/api/changes/${enc(id)}`),
  gates: (id: string) => get<GatesResponse>(`/api/changes/${enc(id)}/gates`),
  /** 分页读取全部事件（升序） */
  events: async (id?: string): Promise<ForgeEvent[]> => {
    const out: ForgeEvent[] = [];
    for (let after = 0; ; ) {
      const base = id ? `/api/changes/${enc(id)}/events` : '/api/events';
      const page = (await get<{ events: ForgeEvent[] }>(`${base}?limit=${PAGE}&after=${after}`)).events;
      out.push(...page);
      if (page.length < PAGE) return out;
      after = page.at(-1)!.seq;
    }
  },
  evidence: (id: string) => get<{ evidence: EvidenceEntry[] }>(`/api/changes/${enc(id)}/evidence`).then((r) => r.evidence),
  evidenceDetail: (id: string, eid: string) => get<EvidenceDetail>(`/api/changes/${enc(id)}/evidence/${enc(eid)}`),
  chain: () => get<ChainStatus>('/api/log/verify'),
  me: () => get<{ required: boolean; user: SessionUser | null }>('/api/auth/me'),
  login: (name: string, token: string) =>
    request<{ user: SessionUser }>('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, token }) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  users: () => get<{ users: { name: string; roles: Role[]; admin: boolean; disabled: boolean }[] }>('/api/users').then((r) => r.users),

  // ---------- 写操作（T3.4）：服务端按登录用户 + role 校验，走 Store.mutate ----------
  questionAction: (id: string, qid: string, action: QuestionAction, body: Record<string, unknown>) =>
    post<{ question: Question }>(`/api/changes/${enc(id)}/questions/${enc(qid)}/${action}`, body),
  confirmRestatement: (id: string, body: { role: Role; via?: string }) => post<{ ok: true }>(`/api/changes/${enc(id)}/restatement/confirm`, body),
  decideAssumption: (id: string, aid: string, body: { role: Role; status: 'accepted' | 'rejected'; note?: string }) =>
    post<{ ok: true }>(`/api/changes/${enc(id)}/assumptions/${enc(aid)}/decide`, body),
  approve: (id: string, body: { role: Role; target: 'spec' | 'design'; note?: string }) => post<{ hash: string }>(`/api/changes/${enc(id)}/approve`, body),
  signoff: (id: string, body: { role: Role; verdict: 'pass' | 'fail'; note?: string; findings?: ReviewFinding[] }) =>
    post<{ review: ReviewRecord; change: Change }>(`/api/changes/${enc(id)}/signoff`, body),
  claimTask: (id: string, tid: string, body: { role: Role; note?: string }) => post<{ ok: true }>(`/api/changes/${enc(id)}/tasks/${enc(tid)}/claim`, body),
  releaseTask: (id: string, tid: string, body: { role: Role; reason?: string }) => post<{ ok: true }>(`/api/changes/${enc(id)}/tasks/${enc(tid)}/release`, body),
  artifacts: (id: string) => get<{ files: ArtifactView[]; orphanComments: ArtifactComment[] }>(`/api/changes/${enc(id)}/artifacts`),
  addComment: (id: string, body: { role: Role; path: string; line: number; text: string }) => post<{ comment: ArtifactComment }>(`/api/changes/${enc(id)}/comments`, body),
  commentAction: (id: string, cid: string, action: 'resolve' | 'reopen', body: { role: Role; note?: string }) =>
    post<{ ok: true }>(`/api/changes/${enc(id)}/comments/${enc(cid)}/${action}`, body),
  advance: (id: string, body: { role: Role }) => post<{ from: Stage; to: Stage }>(`/api/changes/${enc(id)}/advance`, body),
};
