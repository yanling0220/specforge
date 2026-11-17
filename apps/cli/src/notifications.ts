import {
  feishuCredentials, ForgeError, notificationMessage, parseNotificationSettings,
  type NotificationSettings,
} from '@specforge/core';
import { readNotificationConfig } from '@specforge/runner';
import { NotificationLedger, type Store } from '@specforge/store';
import type { NotificationRecord } from '@specforge/shared';

export interface NotifyOptions {
  file: string;
  projectId: string;
  changeId?: string;
  multiProject?: boolean;
  as?: string;
  reason?: string;
  acceptDuplicateRisk?: boolean;
}

function context(store: Store, options: NotifyOptions) {
  const entry = readNotificationConfig(options.file).projects.find((item) => item.projectId === options.projectId);
  if (!entry) throw new ForgeError('not_found', '通知配置没有指定项目，不能使用默认项目');
  let settings: NotificationSettings | undefined;
  let credentials: ReturnType<typeof feishuCredentials> | undefined;
  try {
    settings = parseNotificationSettings(entry);
    credentials = feishuCredentials(settings, process.env);
  } catch { /* 只显示配置状态，不输出环境值或原始错误。 */ }
  const ledger = new NotificationLedger(store, {
    projectId: options.projectId, enabled: settings?.enabled === true,
    route: credentials?.route ?? settings?.route, available: !!credentials,
  });
  return { settings, credentials, ledger, enabled: entry.enabled === true };
}

function summary(record: NotificationRecord) {
  const demand = record.demand;
  return {
    id: 'n-' + record.key.slice(0, 12), key: record.key, changeId: demand.changeId,
    kind: demand.kind, role: demand.role,
    ...(demand.kind === 'question-confirmation'
      ? { questionId: demand.questionId, revision: demand.rev, answerHash: demand.answerHash.slice(0, 8) }
      : { sha: demand.sha }),
    route: record.routeId, status: record.status, attempts: record.attempts,
    round: record.retry?.round ?? 0,
    attemptsThisRound: record.attempts - (record.retry?.afterAttempts ?? 0),
    nextAttemptAt: record.nextAttemptAt ?? null, reason: record.reason ?? null,
  };
}

/** 不加载发送器或创建 worker；只读命令也不恢复 started。 */
export function cmdNotify(store: Store, action: string, options: NotifyOptions, reference?: string) {
  return store.exclusive(() => {
    if (!['preview', 'status', 'retry'].includes(action)) {
      throw new ForgeError('bad_cmd', '用法：sf notify preview | status | retry（见 --help）');
    }
    const { settings, credentials, ledger, enabled } = context(store, options);
    const base = {
      projectId: options.projectId, enabled,
      configuration: settings && credentials ? 'ready' : 'blocked',
      delivery: 'accepted 仅表示接口受理，不代表已读或业务确认；unknown 不自动重发',
    };
    const matches = (record: NotificationRecord) => !options.changeId || record.demand.changeId === options.changeId;
    if (action === 'status') {
      const records = ledger.list().filter(matches);
      return { ...base, count: records.length, records: records.map(summary) };
    }
    if (action === 'preview') {
      const candidates = ledger.preview().filter(({ record }) => matches(record));
      return {
        ...base, pendingCount: candidates.length,
        eligibleAfterEnableCount: candidates.filter(({ record, recipients }) => recipients.ok && ['queued', 'retry_wait'].includes(record.status)).length,
        candidates: candidates.map(({ record, recipients, existing }) => {
          const message = settings ? notificationMessage(record, recipients.ok ? recipients.members : [], {
            alias: settings.alias, publicBaseUrl: settings.publicBaseUrl, multiProject: options.multiProject === true,
          }) : undefined;
          const nodes = message?.content.post.zh_cn.content.flat();
          return {
            ...summary(record), existing, recipientStatus: recipients.ok ? 'ready' : recipients.reason,
            message: message ? {
              title: message.content.post.zh_cn.title,
              text: nodes!.flatMap((node) => node.tag === 'text' ? [node.text] : []),
              mentions: recipients.ok ? recipients.members.map((member) => member.name) : [],
              links: nodes!.flatMap((node) => node.tag === 'a' ? [node.href] : []),
            } : null,
          };
        }),
      };
    }
    if (!settings || !credentials) throw new ForgeError('notification_config', '当前通知配置或凭据不可用，请修复后重试');
    if (!reference) throw new ForgeError('missing_arg', '缺少通知编号或完整 key');
    const prefix = reference.startsWith('n-') ? reference.slice(2) : reference;
    if (!/^[a-f0-9]{12,64}$/.test(prefix)) throw new ForgeError('bad_arg', '通知编号需为 n- 加至少 12 位十六进制，或完整 key');
    const records = ledger.list().filter((record) => matches(record) && record.key.startsWith(prefix));
    if (records.length !== 1) throw new ForgeError('notification_conflict', '通知编号不存在或有歧义，请使用本项目完整 key');
    const record = ledger.retry(records[0]!.key, store.identity(options.as), {
      reason: options.reason ?? '', acceptDuplicateRisk: options.acceptDuplicateRisk,
    });
    return { ...base, queued: true, record: summary(record), note: '仅登记新预算；发送由服务端 worker 执行' };
  });
}
