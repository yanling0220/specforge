import { readFileSync } from 'node:fs';
import { ForgeError, parseNotificationConfig, type NotificationConfig } from '@specforge/core';

/** 外部服务配置只读，错误不附带路径、原文或凭据。 */
export function readNotificationConfig(file: string): NotificationConfig {
  try { return parseNotificationConfig(JSON.parse(readFileSync(file, 'utf8'))); }
  catch { throw new ForgeError('notification_config', '通知配置无效，请检查项目配置（不含凭据值）'); }
}
