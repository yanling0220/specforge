import { afterEach, describe, expect, it, vi } from 'vitest';
import { notificationMessage, notificationKey } from '@specforge/core';
import type { NotificationDemand, NotificationRecord } from '@specforge/shared';
import { feishuCredentials, parseNotificationConfig, parseNotificationSettings } from '../src/notification-config.ts';
import { feishuResult, feishuTransport, sendFeishu } from '../src/feishu.ts';
import { notificationSettings, webhook } from './fixtures/notification-project.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const now = 1599360473_000;
const demand: NotificationDemand = { kind: 'question-confirmation', scope: { projectId: 'a', repositoryId: 'f'.repeat(64) }, changeId: 'same', questionId: 'Q-1', rev: 2, answerHash: 'b'.repeat(64), role: 'product', ruleVersion: 1 };
const record: NotificationRecord = { version: 1, key: notificationKey(demand), demand, routeId: 'team', recipientsHash: 'c'.repeat(64), source: { seq: 1, hash: 'd'.repeat(64) }, status: 'started', attempts: 1, updatedAt: new Date(now).toISOString() };
const message = notificationMessage(record, [{ name: 'pm', memberId: 'ou_pm' }], { alias: '项目', publicBaseUrl: 'https://console.example.invalid/prefix', multiProject: true });

describe('飞书配置与最小消息', () => {
  it('逐项目严格解析；拒绝直接凭据、任意目的地、重复映射、广播和非 Open ID', () => {
    const settings = notificationSettings();
    expect(parseNotificationSettings(settings)).toEqual(settings);
    expect(parseNotificationSettings({ ...settings, publicBaseUrl: 'https://example.invalid/console/team/' }).publicBaseUrl).toBe('https://example.invalid/console/team');
    for (const value of [
      { ...settings, webhook: 'private-value' }, { ...settings, provider: 'other' }, { ...settings, enabled: 'true' },
      { ...settings, publicBaseUrl: 'http://example.invalid' }, { ...settings, publicBaseUrl: 'https://user:secret@example.invalid' },
      { ...settings, publicBaseUrl: 'https://example.invalid/prefix//' },
      { ...settings, publicBaseUrl: 'https://example.invalid/prefix/..' },
      { ...settings, publicBaseUrl: 'https://example.invalid/%70refix' },
      { ...settings, publicBaseUrl: 'https://example.invalid/?token=secret' }, { ...settings, alias: '<at user_id="all">' },
      { ...settings, route: { ...settings.route, members: [{ name: 'pm', memberId: 'all' }] } },
      { ...settings, route: { ...settings.route, members: [{ name: 'pm', memberId: 'user_id' }] } },
      { ...settings, route: { ...settings.route, members: [...settings.route.members, ...settings.route.members] } },
    ]) expect(() => parseNotificationSettings(value)).toThrow(/通知配置/);
    expect(() => parseNotificationConfig({ version: 1, projects: [settings, settings] })).toThrow();
    // 单项错误仍按 ID 保留，供对应 worker 暂停，不影响其他项目。
    expect(parseNotificationConfig({ version: 1, projects: [{ projectId: 'a', provider: 'broken' }] }).projects).toHaveLength(1);
  });

  it('环境凭据缺失或非法失败关闭且不泄露值；目标变化影响指纹，签名密钥轮换不影响', () => {
    const settings = notificationSettings();
    const env = { [settings.webhookEnv]: webhook(), [settings.signingSecretEnv]: 'private-secret' };
    const valid = feishuCredentials(settings, env);
    expect(feishuCredentials(settings, { ...env, [settings.signingSecretEnv]: 'rotated' }).route).toEqual(valid.route);
    expect(feishuCredentials(settings, { ...env, [settings.webhookEnv]: webhook('b') }).route).not.toEqual(valid.route);
    for (const value of ['', 'http://open.feishu.cn/open-apis/bot/v2/hook/private', `${webhook()}?secret=private`, webhook().replace('open.feishu.cn', 'localhost'), webhook().replace('open.feishu.cn', 'open.feishu.cn.evil.invalid')]) {
      expect(() => feishuCredentials(settings, { ...env, [settings.webhookEnv]: value })).toThrow(/^通知配置无效/);
    }
    expect(() => feishuCredentials(settings, {})).toThrow(/通知配置/);
  });

  it('两类最小内容只含版本快照；结构化文本不能注入 @all 或额外链接，部署前缀与各段正确编码', () => {
    const hostile = { ...record, demand: { ...demand, changeId: '<at user_id="all">&?#' } };
    const rendered = notificationMessage(hostile, [{ name: 'private-name', memberId: 'ou_pm' }], { alias: '项目', publicBaseUrl: 'https://console.example.invalid/prefix', multiProject: true });
    const nodes = rendered.content.post.zh_cn.content.flat();
    expect(nodes.filter((node) => node.tag === 'at')).toEqual([{ tag: 'at', user_id: 'ou_pm' }]);
    expect(nodes.filter((node) => node.tag === 'a')).toEqual([{ tag: 'a', text: '打开平台核对当前状态', href: 'https://console.example.invalid/prefix/p/a/#/changes/%3Cat%20user_id%3D%22all%22%3E%26%3F%23/analysis/Q-1' }]);
    expect(JSON.stringify(rendered)).not.toMatch(/private-|repositoryId|recipientsHash|source/);
    const signoff = notificationMessage({ ...record, demand: { kind: 'human-signoff', scope: demand.scope, changeId: 'same', sha: 'e'.repeat(40), role: 'dev', ruleVersion: 1 } }, [], { alias: '项目', publicBaseUrl: 'https://console.example.invalid', multiProject: false });
    expect(JSON.stringify(signoff)).toContain('待 dev 签字');
    expect(JSON.stringify(signoff)).toContain('https://console.example.invalid/#/changes/same');
  });
});

describe('飞书官方契约及保守结果分类', () => {
  it('官方签名算法固定向量与结构化 post；HTTP 和业务码必须同时成功', async () => {
    const transport = vi.fn(async (_url: string, body: string) => {
      const parsed = JSON.parse(body);
      expect(parsed.timestamp).toBe('1599360473');
      expect(parsed.sign).toBe('l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=');
      expect(parsed.msg_type).toBe('post');
      return { status: 200, code: 0, legacyCode: 0, retryAfter: null };
    });
    expect(await sendFeishu({ webhook: webhook(), secret: 'demo', message, attempt: 1, now: () => now, transport })).toEqual({ kind: 'accepted' });
    for (const response of [{ status: 200 }, { status: 200, legacyCode: 0 }, { status: 200, code: 0, legacyCode: 1 }, { status: 429, code: 0 }, { status: 429, code: 11232, legacyCode: 0 }, { status: 503, code: 0 }, { status: 200, code: 123456 }]) {
      expect(feishuResult({ retryAfter: null, ...response }, 1, now)).toEqual({ kind: 'unknown' });
    }
    for (const code of [9499, 19021, 19022, 19024]) expect(feishuResult({ status: 200, code, retryAfter: null }, 1, now)).toEqual({ kind: 'failed' });
    for (const status of [301, 400, 401, 403, 404]) expect(feishuResult({ status, retryAfter: null }, 1, now)).toEqual({ kind: 'failed' });
  });

  it('只有明确限流安全重试：本地退避 / 抖动 / Retry-After 取较晚值', () => {
    for (const [attempt, seconds] of [[1, 10], [2, 30], [3, 120], [4, 600], [5, 600]]) {
      expect(feishuResult({ status: 200, code: 11232, retryAfter: null }, attempt!, now, () => 0)).toEqual({ kind: 'retry', retryAt: new Date(now + seconds! * 1000).toISOString() });
    }
    expect(feishuResult({ status: 429, retryAfter: '90' }, 1, now, () => 0)).toEqual({ kind: 'retry', retryAt: new Date(now + 90_000).toISOString() });
    expect(feishuResult({ status: 429, retryAfter: new Date(now + 120_000).toUTCString() }, 1, now, () => 0)).toEqual({ kind: 'retry', retryAt: new Date(now + 120_000).toISOString() });
    expect(feishuResult({ status: 429, retryAfter: 'invalid' }, 1, now, () => 0.5)).toEqual({ kind: 'retry', retryAt: new Date(now + 11_000).toISOString() });
    expect(feishuResult({ status: 503, code: 11232, retryAfter: '1' }, 1, now)).toEqual({ kind: 'unknown' });
  });

  it('超时和断线为 unknown；非法地址和超大请求在外连前拒绝', async () => {
    const transport = vi.fn(async () => { throw new Error('private-url private-response'); });
    expect(await sendFeishu({ webhook: webhook(), secret: 'demo', message, attempt: 1, transport })).toEqual({ kind: 'unknown' });
    let signal: AbortSignal | undefined;
    expect(await sendFeishu({ webhook: webhook(), secret: 'demo', message, attempt: 1, timeoutMs: 5, transport: async (_url, _body, input) => { signal = input; return new Promise(() => {}); } })).toEqual({ kind: 'unknown' });
    expect(signal?.aborted).toBe(true);
    transport.mockClear();
    expect(await sendFeishu({ webhook: 'https://evil.invalid', secret: 'demo', message, attempt: 1, transport })).toEqual({ kind: 'failed' });
    const huge = structuredClone(message); huge.content.post.zh_cn.title = '大'.repeat(20_000);
    expect(await sendFeishu({ webhook: webhook(), secret: 'demo', message: huge, attempt: 1, transport })).toEqual({ kind: 'failed' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('生产传输拒绝重定向；只返回脱敏字段，响应正文有界且坏 JSON 不冒充成功', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code: 0, StatusCode: 0, msg: 'private-response' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const response = await feishuTransport(webhook(), '{}', new AbortController().signal);
    expect(response).toEqual({ status: 200, code: 0, legacyCode: 0, retryAfter: null });
    expect(fetch.mock.calls[0]).toMatchObject([webhook(), { redirect: 'manual', method: 'POST', headers: { 'Content-Type': 'application/json' } }]);
    fetch.mockImplementation(async () => new Response('x'.repeat(40_000), { status: 200 }));
    expect(await feishuTransport(webhook(), '{}', new AbortController().signal)).toEqual({ status: 200, retryAfter: null });
    fetch.mockImplementation(async () => new Response('invalid', { status: 200 }));
    expect((await feishuTransport(webhook(), '{}', new AbortController().signal)).code).toBeUndefined();
  });
});
