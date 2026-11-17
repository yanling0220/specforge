import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimNotificationWorker } from '@specforge/runner';
import { NotificationLedger, Store } from '@specforge/store';
import { NotificationWorker } from '../../src/notification-worker.ts';
import { feishuCredentials } from '../../src/notification-config.ts';
import { notificationSettings } from './notification-project.ts';

const store = new Store(process.argv[2]!);
const mode = process.argv[3]!;
const settings = notificationSettings();
if (mode === 'queued') {
  claimNotificationWorker(store.root);
  new NotificationLedger(store, { projectId: 'a', enabled: true, route: feishuCredentials(settings).route }).reconcile();
  process.send!('checkpoint');
} else {
  const worker = new NotificationWorker({
    store, projectId: 'a', settings, multiProject: false, check() {},
    transport: async () => {
      if (mode === 'accepted-unrecorded') writeFileSync(join(store.root, 'remote-marker'), 'accepted');
      if (mode !== 'accepted-recorded') {
        process.send!('checkpoint');
        return new Promise(() => {});
      }
      return { status: 200, code: 0, retryAfter: null };
    },
  });
  await worker.tick();
  process.send!('checkpoint');
}
// IPC 保持进程存活，由父进程在已释放业务锁的检查点强制结束。
process.on('message', () => {});
