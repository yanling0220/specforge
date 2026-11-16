import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  chainEvent, finishNotification, ForgeError, hashOf, notificationDemands, notificationKey, notificationRecipients,
  projectNotifications, queueNotification, reconcileNotification, startNotification,
} from '@specforge/core';
import { headSha } from '@specforge/runner';
import type {
  ForgeEvent, NotificationDemand, NotificationRecipients, NotificationRecord, NotificationResult, NotificationRoute, NotificationScope, UserRegistry,
} from '@specforge/shared';
import { verifyLog } from './audit.ts';
import { evaluateAll } from './engine.ts';
import type { Store } from './store.ts';

const actor = { name: 'specforge-notifier', role: 'agent' as const };

/** 与已有索引绑定相同的本机仓库身份规则；源路径不进入通知事件。 */
function repositoryIdentity(store: Store): string {
  const root = realpathSync(store.root);
  const entry = statSync(join(root, '.git'));
  return hashOf([root, entry.dev, entry.ino]);
}

interface Snapshot {
  events: ForgeEvent[];
  registry: UserRegistry;
  records: NotificationRecord[];
}

/**
 * 引擎内部的通知账本。没有定时器、凭据读取、网络 IO 或 agent 平台工具。
 * 调用者必须在发送结果分类后调用 finish；真实 worker 在 T4.5c 接入。
 */
export class NotificationLedger {
  readonly scope: NotificationScope;
  private readonly enabled: boolean;
  private readonly route?: NotificationRoute;
  private readonly now: () => string;
  private readonly store: Store;

  constructor(store: Store, options: {
    projectId: string; enabled?: boolean; route?: NotificationRoute; now?: () => string;
  }) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.projectId)) throw new ForgeError('bad_arg', '通知需要稳定的项目 ID');
    this.store = store;
    this.scope = Object.freeze({ projectId: options.projectId, repositoryId: repositoryIdentity(store) });
    this.enabled = options.enabled === true;
    this.route = options.route && structuredClone(options.route);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private snapshot(): Snapshot {
    if (repositoryIdentity(this.store) !== this.scope.repositoryId) throw new ForgeError('notification_binding', '通知仓库身份已改变');
    this.store.config();
    if (!verifyLog(this.store).ok) throw new ForgeError('notification_unavailable', '项目链、状态、名册或锚定异常，通知已暂停');
    const registry = this.store.users();
    if (!registry) throw new ForgeError('notification_unavailable', '通知需要启用项目用户名册');
    const events = this.store.events();
    return { events, registry, records: projectNotifications(events, this.scope) };
  }

  private demands(now: string): NotificationDemand[] {
    const sha = headSha(this.store.root);
    return this.store.listChanges().flatMap((id) => {
      const state = this.store.load(id);
      return notificationDemands({
        scope: this.scope, change: state.change, questions: state.questions, reviews: state.reviews,
        // 其他阶段的问题提醒不需要运行收尾的 Git / 验证门评估。
        gates: state.change.stage === 'closing' ? evaluateAll(this.store, state) : {}, headSha: sha, now,
      });
    });
  }

  private persist(record: NotificationRecord, events: ForgeEvent[]): void {
    const input = {
      actor, type: `notification.${record.status}`, changeId: record.demand.changeId,
      payload: { version: 1, record },
    };
    // 同一解析器用于写前约束和重建；未知字段不能将原始响应意外带入链中。
    projectNotifications([...events, chainEvent(events.at(-1), input, this.now())], this.scope);
    this.store.mutate(record.demand.changeId, actor, input.type, (state) => state, () => input.payload);
  }

  /** 只读投影，不写“已读”状态，也不触发发送。 */
  list(): NotificationRecord[] {
    return this.store.exclusive(() => this.snapshot().records);
  }

  /** 默认未启用时完全无通知写入；首次启用只补当前仍然存在的需求。 */
  reconcile(): NotificationRecord[] {
    if (!this.enabled) return [];
    return this.store.exclusive(() => {
      const { registry, events, records } = this.snapshot();
      const now = this.now();
      const demands = new Map(this.demands(now).map((demand) => [notificationKey(demand), demand]));
      const selections = new Map<string, NotificationRecipients>();
      for (const [key, demand] of demands) selections.set(key, notificationRecipients(demand.role, registry, this.route));
      for (const record of records) {
        const next = reconcileNotification(record, selections.get(record.key), now);
        if (next !== record) this.persist(next, this.store.events());
      }
      const existing = new Set(records.map((record) => record.key));
      const last = events.at(-1)!; // 有 change 就必然有创建事件。
      for (const [key, demand] of demands) {
        if (!existing.has(key)) this.persist(queueNotification(demand, selections.get(key)!, { seq: last.seq, hash: last.hash }, now), this.store.events());
      }
      return projectNotifications(this.store.events(), this.scope);
    });
  }

  /** 重新核对当前事实并持久化 started；返回后已释放仓库锁。 */
  prepare(key: string): { record: NotificationRecord; members: NotificationRoute['members'] } | undefined {
    if (!this.enabled) return undefined;
    return this.store.exclusive(() => {
      const records = this.reconcile();
      // 同一仓库至多一个已登记且尚未落结果的发送，独立进程也看相同账本。
      if (records.some((record) => record.status === 'started')) return undefined;
      const record = records.find((entry) => entry.key === key);
      if (!record) return undefined;
      const selection = notificationRecipients(record.demand.role, this.store.users()!, this.route);
      if (!selection.ok || selection.fingerprint !== record.recipientsHash || selection.routeId !== record.routeId) return undefined;
      const next = startNotification(record, this.now());
      if (!next) return undefined;
      this.persist(next, this.store.events());
      return { record: next, members: selection.members };
    });
  }

  /** 即使 worker 已关闭，也允许把在途请求的结果落盘；不发起或重放网络请求。 */
  finish(key: string, attempt: number, result: NotificationResult): NotificationRecord {
    return this.store.exclusive(() => {
      const { records, events } = this.snapshot();
      const record = records.find((entry) => entry.key === key);
      if (!record || record.attempts !== attempt) throw new ForgeError('notification_conflict', '通知发送尝试已变化');
      if (record.status === 'accepted' && result.kind === 'accepted') return record;
      const next = finishNotification(record, result, this.now());
      this.persist(next, events);
      return next;
    });
  }

  /** 只在独占 worker 启动、确认上一 worker 已退出后调用，不作为周期性扫描。 */
  recoverInterrupted(): NotificationRecord[] {
    return this.store.exclusive(() => {
      const { records } = this.snapshot();
      for (const record of records) {
        if (record.status === 'started') this.persist({ ...record, status: 'unknown', reason: 'interrupted', updatedAt: this.now() }, this.store.events());
      }
      return projectNotifications(this.store.events(), this.scope);
    });
  }
}
