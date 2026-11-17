import type { HumanRole } from './index.ts';

export interface NotificationScope {
  projectId: string;
  /** 服务端采集的仓库身份指纹，不含原始文件系统路径 */
  repositoryId: string;
}

interface NotificationBase {
  scope: NotificationScope;
  changeId: string;
  ruleVersion: 1;
}

export type NotificationDemand = NotificationBase & (
  | { kind: 'question-confirmation'; questionId: string; rev: number; answerHash: string; role: HumanRole }
  | { kind: 'human-signoff'; sha: string; role: 'dev' }
);

/** 仅服务端 / 本地引擎持有；原始成员 ID 不写入发送账本。 */
export interface NotificationRoute {
  id: string;
  provider: 'feishu';
  /** 目的地变化时显式修改，不能把更换群当作原路由继续发送。 */
  revision: string;
  members: { name: string; memberId: string }[];
}

export type NotificationRecipients =
  | { ok: true; routeId: string; fingerprint: string; members: NotificationRoute['members'] }
  | { ok: false; routeId: string | null; reason: 'no_route' | 'no_recipients' | 'invalid_mapping' | 'configuration' };

export type NotificationStatus = 'queued' | 'started' | 'accepted' | 'retry_wait' | 'blocked' | 'failed' | 'unknown' | 'cancelled';
export type NotificationReason = 'no_route' | 'no_recipients' | 'invalid_mapping' | 'recipient_changed' | 'configuration'
  | 'demand_resolved' | 'interrupted' | 'delivery_failed' | 'retry_exhausted';

/** 可由 notification.* 事件重建的、无业务正文及凭据的发送投影。 */
export interface NotificationRecord {
  version: 1;
  key: string;
  demand: NotificationDemand;
  routeId: string | null;
  recipientsHash: string | null;
  source: { seq: number; hash: string };
  status: NotificationStatus;
  attempts: number;
  updatedAt: string;
  reason?: NotificationReason;
  nextAttemptAt?: string;
  /** 暂时不再需要提醒后，恢复就绪时仍保留原预算及暂停原因。 */
  cancelledFrom?: 'queued' | 'retry_wait' | 'blocked' | 'failed';
}

/** 渠道适配层只提交已分类结果，不能把原始响应 / 异常写入链。 */
export type NotificationResult =
  | { kind: 'accepted' }
  | { kind: 'retry'; retryAt: string }
  | { kind: 'failed' }
  | { kind: 'unknown' };
