import type { ReactNode } from 'react';

export function Loading({ error, children }: { error?: Error; children?: ReactNode }) {
  if (error) return <div className="error">加载失败：{error.message}</div>;
  return <div className="muted">{children ?? '加载中…'}</div>;
}

export function StatusIcon({ status }: { status?: string }) {
  if (status === 'passed') return <span className="icon pass">✓</span>;
  if (status === 'failed') return <span className="icon fail">✗</span>;
  return <span className="icon none">·</span>;
}

/** 可折叠的 JSON 原文 */
export function Raw({ value, label = '原始数据' }: { value: unknown; label?: string }) {
  return (
    <details className="raw">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
