import { ForgeError } from './errors.ts';
import { hashOf } from './hash.ts';
import { deploymentPath } from './deployment.ts';
import type { NotificationRoute } from '@specforge/shared';

export interface NotificationSettings {
  projectId: string;
  enabled: boolean;
  provider: 'feishu';
  alias: string;
  publicBaseUrl: string;
  webhookEnv: string;
  signingSecretEnv: string;
  route: NotificationRoute;
}
export interface NotificationConfig { version: 1; projects: { projectId: string; [key: string]: unknown }[] }
export const validFeishuWebhook = (value: unknown): value is string => typeof value === 'string'
  && /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-f0-9-]{16,128}$/.test(value);
const projectId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const envName = (value: unknown): value is string => typeof value === 'string' && /^[A-Z_][A-Z0-9_]{0,127}$/.test(value);
const bad = (): never => { throw new ForgeError('notification_config', '通知配置无效，请检查项目配置（不含凭据值）'); };

/** 外层只能按稳定项目 ID 寻址；单项内容稍后逐项目校验，错误不影响业务或健康项目。 */
export function parseNotificationConfig(value: unknown): NotificationConfig {
  const config = value as NotificationConfig;
  if (!config || config.version !== 1 || !Array.isArray(config.projects) || Object.keys(config).some((key) => !['version', 'projects'].includes(key))) return bad();
  const ids = new Set<string>();
  for (const entry of config.projects) {
    if (!entry || !projectId(entry.projectId) || ids.has(entry.projectId)) return bad();
    ids.add(entry.projectId);
  }
  return structuredClone(config);
}

export function parseNotificationSettings(value: unknown): NotificationSettings {
  const entry = value as NotificationSettings;
  if (!entry || !projectId(entry.projectId) || typeof entry.enabled !== 'boolean' || entry.provider !== 'feishu'
    || Object.keys(entry).some((key) => !['projectId', 'enabled', 'provider', 'alias', 'publicBaseUrl', 'webhookEnv', 'signingSecretEnv', 'route'].includes(key))
    || typeof entry.alias !== 'string' || !entry.alias.trim() || entry.alias.length > 80 || /[<>\x00-\x1f]/.test(entry.alias)
    || !envName(entry.webhookEnv) || !envName(entry.signingSecretEnv)) return bad();
  let url: URL;
  try { url = new URL(entry.publicBaseUrl); } catch { return bad(); }
  let prefix: string;
  try {
    if (typeof entry.publicBaseUrl !== 'string' || !entry.publicBaseUrl.startsWith('https://')) return bad();
    const slash = entry.publicBaseUrl.indexOf('/', 8);
    prefix = deploymentPath(slash === -1 ? '' : entry.publicBaseUrl.slice(slash));
  } catch { return bad(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || /[\\\x00-\x20]/.test(entry.publicBaseUrl) || url.pathname.includes('%')) return bad();
  if (url.pathname !== (prefix || '/') && url.pathname !== prefix + '/') return bad();
  const route = entry.route;
  if (!route || !projectId(route.id) || route.provider !== 'feishu' || typeof route.revision !== 'string'
    || !/^[A-Za-z0-9._-]{1,80}$/.test(route.revision) || !Array.isArray(route.members) || route.members.length > 50
    || Object.keys(route).some((key) => !['id', 'provider', 'revision', 'members'].includes(key))) return bad();
  const names = new Set<string>(); const ids = new Set<string>();
  for (const member of route.members) {
    // 首版统一使用 Open ID，兼容外部群；不猜测邮箱 / 用户名，也不接受 all。
    if (!member || typeof member.name !== 'string' || !member.name || member.name.length > 128
      || typeof member.memberId !== 'string' || !/^ou_[A-Za-z0-9_-]{1,124}$/.test(member.memberId)
      || names.has(member.name) || ids.has(member.memberId)
      || Object.keys(member).some((key) => !['name', 'memberId'].includes(key))) return bad();
    names.add(member.name); ids.add(member.memberId);
  }
  return { ...structuredClone(entry), publicBaseUrl: url.origin + prefix };
}

/** URL 本身是凭据，拒绝任何别名主机、重定向目的地和附加参数。 */
export function feishuCredentials(settings: NotificationSettings, env: NodeJS.ProcessEnv): { webhook: string; secret: string; route: NotificationRoute } {
  const webhook = env[settings.webhookEnv]; const secret = env[settings.signingSecretEnv];
  if (!validFeishuWebhook(webhook) || !secret || secret.length > 1024 || /[\r\n]/.test(secret)) return bad();
  // Webhook 更换意味着换目标，不能仅靠管理员记得增加 revision 来保护旧快照。
  return { webhook, secret, route: { ...settings.route, revision: hashOf({ revision: settings.route.revision, destination: webhook }) } };
}
