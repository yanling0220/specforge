import type {
  Actor,
  Analysis,
  Approval,
  Change,
  ForgeEvent,
  GateEvaluation,
  GateId,
  Question,
  ReviewRecord,
  Role,
  Stage,
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
}

export interface GatesResponse {
  stage: Stage;
  pipeline: { stage: Stage; exitGate?: GateId }[];
  gates: Partial<Record<GateId, GateEvaluation>>;
  upstreamInvalid: GateId[];
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

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const body = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!res.ok) throw new ApiError(res.status, body.error?.code ?? 'http', body.error?.message ?? `请求失败：${res.status}`);
  return body as T;
}

const enc = encodeURIComponent;
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
};
