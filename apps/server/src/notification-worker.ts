import { ForgeError, notificationMessage } from '@specforge/core';
import { claimNotificationWorker } from '@specforge/runner';
import { NotificationLedger, type Store } from '@specforge/store';
import type { NotificationRecord, NotificationResult } from '@specforge/shared';
import { feishuCredentials, parseNotificationSettings } from './notification-config.ts';
import { sendFeishu, type FeishuTransport } from './feishu.ts';

export interface NotificationWorkerOptions {
  store: Store;
  projectId: string;
  settings: unknown;
  multiProject: boolean;
  deploymentPath?: string;
  check(): void;
  transport?: FeishuTransport;
  now?: () => number;
  random?: () => number;
}
export interface NotificationWorkerStatus {
  state: 'disabled' | 'running' | 'blocked' | 'paused' | 'stopped';
  reason?: 'configuration' | 'write_busy' | 'project_integrity' | 'owner' | 'result_pending';
}

/** 单服务器、每仓库一个 owner；网络和结果记账等待均不持仓库租约。 */
export class NotificationWorker {
  private readonly options: NotificationWorkerOptions;
  private readonly now: () => number;
  private owner?: ReturnType<typeof claimNotificationWorker>;
  private initialized = false;
  private stopped = false;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private unrecorded?: { ledger: NotificationLedger; record: NotificationRecord; result: NotificationResult };
  private state: NotificationWorkerStatus = { state: 'disabled' };
  private lastAttemptAt = -Infinity;

  constructor(options: NotificationWorkerOptions) {
    this.options = { ...options, settings: structuredClone(options.settings) };
    this.now = options.now ?? Date.now;
  }

  status(): NotificationWorkerStatus { return { ...this.state }; }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, 5000);
    void this.tick();
  }

  private async flush(): Promise<boolean> {
    const pending = this.unrecorded;
    if (!pending) return true;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        this.owner!.assert();
        this.options.store.exclusive(() => {
          this.options.check();
          pending.ledger.finish(pending.record.key, pending.record.attempts, pending.result);
        });
        this.unrecorded = undefined;
        return true;
      } catch (error) {
        if (!(error instanceof ForgeError && error.code === 'write_busy') || attempt === 7) break;
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
    this.state = { state: 'paused', reason: 'result_pending' };
    return false;
  }

  private async run(): Promise<void> {
    const { store, projectId, multiProject, settings: raw, check } = this.options;
    // 即使停用 / 关闭，已经取得的结果也只记账，不重复发网络请求。
    if (!await this.flush() || this.stopped) return;
    if (!raw || (raw as { enabled?: unknown }).enabled === false) { this.state = { state: 'disabled' }; return; }
    let settings: ReturnType<typeof parseNotificationSettings> | undefined;
    let credentials: ReturnType<typeof feishuCredentials> | undefined;
    try {
      settings = parseNotificationSettings(raw);
      if (settings.projectId !== projectId) throw new Error();
      if (new URL(settings.publicBaseUrl).pathname !== (this.options.deploymentPath || '/')) throw new Error();
      credentials = feishuCredentials(settings);
    } catch { this.state = { state: 'blocked', reason: 'configuration' }; }
    const ledger = store.exclusive(() => {
      check();
      if (!this.owner) this.owner = claimNotificationWorker(store.root);
      this.owner.assert();
      const current = new NotificationLedger(store, {
        projectId, enabled: true, route: credentials?.route ?? settings?.route,
        available: !!credentials, now: () => new Date(this.now()).toISOString(),
      });
      if (!this.initialized) {
        current.recoverInterrupted();
        this.initialized = true;
      }
      return current;
    });
    const records = store.exclusive(() => { check(); this.owner!.assert(); return ledger.reconcile(); });
    if (!credentials || !settings) return;
    this.state = { state: 'running' };
    const last = Math.max(this.lastAttemptAt, ...records.filter((record) => record.attempts > 0).map((record) => Date.parse(record.updatedAt)));
    if (this.now() < last + 2000 || this.stopped) return;
    for (const record of records) {
      const prepared = store.exclusive(() => { check(); this.owner!.assert(); return ledger.prepare(record.key); });
      if (!prepared) continue;
      this.lastAttemptAt = this.now();
      // prepare 返回后不跨 await 再读取业务数据；只用刚刚确认过的最小快照。
      const message = notificationMessage(prepared.record, prepared.members, { alias: settings.alias, publicBaseUrl: settings.publicBaseUrl, multiProject });
      const result = await sendFeishu({ ...credentials, message, attempt: prepared.record.attempts - (prepared.record.retry?.afterAttempts ?? 0), transport: this.options.transport, now: this.now, random: this.options.random });
      this.unrecorded = { ledger, record: prepared.record, result };
      await this.flush();
      return;
    }
  }

  tick(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.stopped) return Promise.resolve();
    this.pending = this.run().catch((error: unknown) => {
      this.state = {
        state: 'paused', reason: error instanceof ForgeError && error.code === 'write_busy' ? 'write_busy'
          : error instanceof ForgeError && error.code === 'notification_owner' ? 'owner' : 'project_integrity',
      };
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.pending;
    // 网络超时有界；未落盘的 started 保留给下一独占 owner 判 unknown。
    if (this.owner) {
      try { this.owner.release(); } catch { /* 不删除别人的所有权 */ }
      this.owner = undefined;
    }
    this.state = { state: 'stopped' };
  }
}
