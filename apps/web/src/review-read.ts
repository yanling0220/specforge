import { api, ApiError, type ReviewFile, type ReviewSnapshot } from './api.ts';

/** Obsolete reads must settle silently even if the response beats fetch's cancellation. */
export function watchReviewRead<T>(
  load: (signal: AbortSignal) => Promise<T>,
  receive: (result: { data: T } | { error: Error }) => void,
): () => void {
  const controller = new AbortController();
  void load(controller.signal).then(
    (data) => { if (!controller.signal.aborted) receive({ data }); },
    (error: Error) => { if (!controller.signal.aborted) receive({ error }); },
  );
  return () => controller.abort();
}

export async function readReviewSnapshot(id: string, signal: AbortSignal): Promise<ReviewSnapshot> {
  const snapshot = await api.review(id, signal);
  if (snapshot.changeId !== id || !snapshot.snapshotVersion) throw new Error('审查快照响应无效');
  return snapshot;
}

export async function readReviewFile(id: string, version: string, fileId: string, signal: AbortSignal): Promise<ReviewFile> {
  const response = await api.reviewFile(id, fileId, version, signal);
  if (response.snapshotVersion !== version || response.file?.file?.id !== fileId) {
    throw new ApiError(409, 'review_stale', '文件响应与当前审查快照不匹配');
  }
  return response.file;
}

export function reviewReadError(error: unknown): 'stale' | 'snapshot' | 'file' {
  if (!(error instanceof ApiError)) return 'file';
  if (error.code === 'review_stale') return 'stale';
  if (error.status === 401 || ['review_unavailable', 'review_not_available', 'recovery_required', 'project_unavailable', 'no_change'].includes(error.code)
    || error.code.startsWith('index_')) return 'snapshot';
  return 'file';
}

/** Add old and new line numbers to a unified patch without interpreting its text as markup. */
export function numberedPatch(patch: string): string {
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  const column = (value?: number) => (value === undefined ? '' : String(value)).padStart(6);
  return patch.split('\n').map((line) => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      oldRemaining = Number(hunk[2] ?? 1);
      newLine = Number(hunk[3]);
      newRemaining = Number(hunk[4] ?? 1);
    }
    let old: number | undefined;
    let next: number | undefined;
    const marker = line[0];
    if (oldRemaining > 0 && (marker === '-' || marker === ' ' || line === '')) {
      old = oldLine++;
      oldRemaining--;
    }
    if (newRemaining > 0 && (marker === '+' || marker === ' ' || line === '')) {
      next = newLine++;
      newRemaining--;
    }
    return column(old) + ' ' + column(next) + '  ' + line;
  }).join('\n');
}
