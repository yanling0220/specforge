import { createHash } from 'node:crypto';

/** 规范化 JSON：对象键排序，保证同样的内容得到同样的哈希 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashOf(value: unknown): string {
  return sha256(canonicalJson(value));
}
