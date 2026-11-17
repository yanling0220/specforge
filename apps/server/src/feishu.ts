import { createHmac } from 'node:crypto';
import type { NotificationResult } from '@specforge/shared';
import type { notificationMessage } from '@specforge/core';
import { validFeishuWebhook } from './notification-config.ts';

export interface FeishuResponse { status: number; retryAfter: string | null; code?: number; legacyCode?: number }
export type FeishuTransport = (webhook: string, body: string, signal: AbortSignal) => Promise<FeishuResponse>;

/** 内存限制也适用于错误响应；任何原文都不离开适配器。 */
export const feishuTransport: FeishuTransport = async (webhook, body, signal) => {
  const response = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal, redirect: 'manual' });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    if (reader) while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 32 * 1024) { await reader.cancel(); return { status: response.status, retryAfter: null }; }
      chunks.push(chunk.value);
    }
    let value: { code?: unknown; StatusCode?: unknown } = {};
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) ?? {}; } catch {}
    return {
      status: response.status, retryAfter: response.headers.get('retry-after'),
      code: typeof value.code === 'number' ? value.code : undefined,
      legacyCode: typeof value.StatusCode === 'number' ? value.StatusCode : undefined,
    };
  } finally { reader?.releaseLock(); }
};

export function feishuResult(response: FeishuResponse, attempt: number, now: number, random: () => number = Math.random): NotificationResult {
  if (response.status >= 500) return { kind: 'unknown' };
  if ((response.code === 0 && response.status !== 200)
    || (response.legacyCode !== undefined && response.code !== undefined && response.legacyCode !== response.code)) return { kind: 'unknown' };
  if (response.status === 200 && response.code === 0 && (response.legacyCode === undefined || response.legacyCode === 0)) return { kind: 'accepted' };
  if (response.status === 429 || (response.status === 200 && response.code === 11232)) {
    const backoff = [10, 30, 120, 600][Math.min(Math.max(attempt - 1, 0), 3)]! * 1000;
    let after = 0;
    if (response.retryAfter) {
      after = /^\d+$/.test(response.retryAfter) ? now + Number(response.retryAfter) * 1000 : Date.parse(response.retryAfter);
      if (!Number.isFinite(after) || after > 8.64e15) after = 0;
    }
    const retryAt = new Date(Math.max(now + backoff + Math.floor(Math.min(1, Math.max(0, random())) * backoff * 0.2), after)).toISOString();
    return { kind: 'retry', retryAt };
  }
  if ((response.status === 200 && [9499, 19021, 19022, 19024].includes(response.code!))
    || (response.status >= 300 && response.status < 500)) return { kind: 'failed' };
  return { kind: 'unknown' };
}

export async function sendFeishu(input: {
  webhook: string; secret: string; message: ReturnType<typeof notificationMessage>; attempt: number;
  transport?: FeishuTransport; now?: () => number; random?: () => number; timeoutMs?: number;
}): Promise<NotificationResult> {
  if (!validFeishuWebhook(input.webhook) || !input.secret) return { kind: 'failed' };
  const now = input.now ?? Date.now;
  const timestamp = String(Math.floor(now() / 1000));
  const sign = createHmac('sha256', `${timestamp}\n${input.secret}`).update('').digest('base64');
  const body = JSON.stringify({ ...input.message, timestamp, sign });
  if (Buffer.byteLength(body) > 20 * 1024) return { kind: 'failed' };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      (input.transport ?? feishuTransport)(input.webhook, body, controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, input.timeoutMs ?? 10_000); }),
    ]);
    return feishuResult(response, input.attempt, now(), input.random);
  } catch {
    // 包括 DNS / connect 错误：fetch 无可靠的未发出证明，统一保守处理。
    return { kind: 'unknown' };
  } finally { clearTimeout(timer); }
}
