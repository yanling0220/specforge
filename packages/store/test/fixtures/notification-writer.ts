import { once } from 'node:events';
import { ForgeError } from '@specforge/core';
import { NotificationLedger, Store } from '../../src/index.ts';

const store = new Store(process.argv[2]!);
const ledger = new NotificationLedger(store, {
  projectId: 'alpha', enabled: true,
  route: { id: 'team', provider: 'feishu', revision: 'v1', members: [{ name: 'pm', memberId: 'ou_pm' }] },
});
process.send!('ready');
await once(process, 'message');
const deadline = Date.now() + 10_000;
while (true) {
  try {
    ledger.reconcile();
    break;
  } catch (error) {
    if (!(error instanceof ForgeError && error.code === 'write_busy') || Date.now() >= deadline) throw error;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
process.disconnect!();
