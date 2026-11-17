import { feishuCredentials as credentials, type NotificationSettings } from '@specforge/core';

export { parseNotificationConfig, parseNotificationSettings, validFeishuWebhook, type NotificationConfig, type NotificationSettings } from '@specforge/core';
export { readNotificationConfig } from '@specforge/runner';

/** 环境读取留在服务入口；共享校验不访问进程环境或网络。 */
export function feishuCredentials(settings: NotificationSettings, env: NodeJS.ProcessEnv = process.env) {
  return credentials(settings, env);
}
