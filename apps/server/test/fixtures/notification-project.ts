import { addUser, sha256 } from '@specforge/core';
import { questionAction, type Store } from '@specforge/store';
import type { NotificationSettings } from '../../src/notification-config.ts';
import { indexActor, indexProject, indexQuestion } from './index-project.ts';

export function notificationProject(): Store {
  const store = indexProject('private-title');
  store.mutateUsers(indexActor, 'user.added', (registry) => addUser(registry, { name: 'dev', roles: ['dev'], admin: true }, sha256('dev-token'), undefined, 'T'), {});
  store.mutateUsers(indexActor, 'user.added', (registry) => addUser(registry, { name: 'pm', roles: ['product'] }, sha256('pm-token'), indexActor, 'T'), {});
  indexQuestion(store);
  questionAction(store, 'same', indexActor, 'Q-1', { kind: 'answer', text: 'private-answer' });
  return store;
}

export const notificationSettings = (id = 'a'): NotificationSettings => ({
  projectId: id, enabled: true, provider: 'feishu', alias: `项目 ${id}`, publicBaseUrl: 'https://console.example.invalid',
  webhookEnv: `SF_TEST_${id.toUpperCase()}_WEBHOOK`, signingSecretEnv: `SF_TEST_${id.toUpperCase()}_SECRET`,
  route: { id: 'team', provider: 'feishu', revision: 'v1', members: [{ name: 'pm', memberId: `ou_${id}_pm` }] },
});
export const webhook = (id = 'a') => `https://open.feishu.cn/open-apis/bot/v2/hook/${id.repeat(32)}`;
