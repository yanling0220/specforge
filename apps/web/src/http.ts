let pending: Promise<unknown> = Promise.resolve();

/** 同一文档内串行发送请求；只重试服务端明确拒绝执行的只读争用。 */
export function fetchWithBusyRetry(input: RequestInfo | URL, init?: RequestInit, request: typeof fetch = fetch): Promise<Response> {
  const response = pending.then(() => send(input, init, request));
  pending = response.catch(() => undefined);
  return response;
}

async function send(input: RequestInfo | URL, init: RequestInit | undefined, request: typeof fetch): Promise<Response> {
  const read = ['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase());
  for (let attempt = 0; ; attempt++) {
    init?.signal?.throwIfAborted();
    const response = await request(input, init);
    if (!read || response.status !== 409 || attempt >= 6) return response;
    const body = await response.clone().json().catch(() => ({})) as { error?: { code?: string } };
    if (body.error?.code !== 'write_busy') return response;
    await new Promise((resolve) => setTimeout(resolve, 30 * 2 ** attempt));
  }
}
