import type { Actor, ArtifactComment, ArtifactTarget } from '@specforge/shared';
import { ForgeError } from './errors.ts';

// 产物评论（T3.5），纯函数。评论锚定到行号 + 该行原文；文件变化后按原文重新定位。

/** 产物路径属于哪类产物；不在该 change 的 OpenSpec 目录下返回 undefined */
export function artifactTargetOf(changeId: string, path: string): ArtifactTarget | undefined {
  const dir = `openspec/changes/${changeId}/`;
  if (!path.startsWith(dir)) return undefined;
  const rest = path.slice(dir.length);
  if (rest === 'proposal.md' || (rest.startsWith('specs/') && rest.endsWith('/spec.md'))) return 'spec';
  if (rest === 'design.md') return 'design';
  if (rest === 'tasks.md') return 'tasks';
  return undefined;
}

export function nextCommentId(comments: ArtifactComment[]): string {
  return `C-${comments.reduce((max, c) => Math.max(max, Number(c.id.slice(2)) || 0), 0) + 1}`;
}

export function addComment(
  comments: ArtifactComment[],
  input: { changeId: string; path: string; line: number; text: string },
  fileText: string | undefined,
  actor: Actor,
  now: string,
): ArtifactComment[] {
  const target = artifactTargetOf(input.changeId, input.path);
  if (!target) throw new ForgeError('bad_path', `只能评论本 change 的 proposal / spec / design / tasks：${input.path}`);
  if (fileText === undefined) throw new ForgeError('not_found', `文件不存在：${input.path}`);
  if (!input.text.trim()) throw new ForgeError('missing_arg', '评论内容不能为空');
  const lines = fileText.split('\n');
  if (!Number.isInteger(input.line) || input.line < 1 || input.line > lines.length) throw new ForgeError('bad_arg', `行号超出范围：1–${lines.length}`);
  const c: ArtifactComment = {
    id: nextCommentId(comments),
    target,
    path: input.path,
    line: input.line,
    quote: lines[input.line - 1]!,
    text: input.text.trim(),
    by: actor,
    at: now,
    status: 'open',
    history: [],
  };
  return [...comments, c];
}

function update(comments: ArtifactComment[], id: string, fn: (c: ArtifactComment) => ArtifactComment): ArtifactComment[] {
  if (!comments.some((c) => c.id === id)) throw new ForgeError('not_found', `评论 ${id} 不存在`);
  return comments.map((c) => (c.id === id ? fn(c) : c));
}

/** 人确认解决（open 或 addressed 都可以） */
export function resolveComment(comments: ArtifactComment[], id: string, actor: Actor, now: string, note?: string): ArtifactComment[] {
  if (actor.role === 'agent') throw new ForgeError('bad_role', '评论只能由人确认解决');
  return update(comments, id, (c) => {
    if (c.status === 'resolved') throw new ForgeError('resolved', `评论 ${id} 已解决`);
    return { ...c, status: 'resolved', history: [...c.history, { kind: 'resolved', by: actor, at: now, ...(note ? { note } : {}) }] };
  });
}

export function reopenComment(comments: ArtifactComment[], id: string, actor: Actor, now: string, note: string): ArtifactComment[] {
  if (actor.role === 'agent') throw new ForgeError('bad_role', '评论只能由人重新打开');
  if (!note.trim()) throw new ForgeError('note_required', '重新打开必须写原因');
  return update(comments, id, (c) => {
    if (c.status === 'open') throw new ForgeError('open', `评论 ${id} 本来就是待处理`);
    return { ...c, status: 'open', history: [...c.history, { kind: 'reopened', by: actor, at: now, note }] };
  });
}

/** 未解决的评论（open 或 addressed）；可按产物过滤 */
export function unresolvedComments(comments: ArtifactComment[], target?: ArtifactTarget): ArtifactComment[] {
  return comments.filter((c) => c.status !== 'resolved' && (!target || c.target === target));
}

/** 待 agent 处理的评论（open） */
export function openComments(comments: ArtifactComment[], target: ArtifactTarget): ArtifactComment[] {
  return comments.filter((c) => c.status === 'open' && c.target === target);
}

/**
 * agent 回应评论：只把 open 的评论改为 addressed（agent 自述不直接算解决，由人确认）。
 * 必须回应本产物全部 open 评论，不能回应不存在或非 open 的评论。
 */
export function addressComments(
  comments: ArtifactComment[],
  target: ArtifactTarget,
  responses: { commentId: string; response: 'fixed' | 'declined'; note: string }[],
  agent: Actor,
  now: string,
): ArtifactComment[] {
  const open = openComments(comments, target).map((c) => c.id);
  const ids = responses.map((r) => r.commentId);
  const unknown = ids.filter((id) => !open.includes(id));
  if (unknown.length) throw new ForgeError('bad_arg', `回应了不存在或不是待处理的评论：${unknown.join(', ')}`);
  const missing = open.filter((id) => !ids.includes(id));
  if (missing.length) throw new ForgeError('bad_arg', `还有评论没有回应：${missing.join(', ')}`);
  if (new Set(ids).size !== ids.length) throw new ForgeError('bad_arg', '同一条评论回应了多次');
  if (responses.some((r) => !r.note.trim())) throw new ForgeError('bad_arg', '每条回应都要写说明');
  return comments.map((c) => {
    const r = responses.find((x) => x.commentId === c.id);
    return r ? { ...c, status: 'addressed', history: [...c.history, { kind: 'addressed', by: agent, at: now, note: r.note, response: r.response }] } : c;
  });
}

export type CommentAnchor = { state: 'exact'; line: number } | { state: 'moved'; line: number } | { state: 'outdated' };

/**
 * 在当前文本中定位评论：原行号上仍是原文 → exact；原文移到了别处 → moved（取离原行号最近的一处）；
 * 原文不在了（或文件不存在）→ outdated。
 */
export function locateComment(c: Pick<ArtifactComment, 'line' | 'quote'>, text: string | undefined): CommentAnchor {
  if (text === undefined) return { state: 'outdated' };
  const lines = text.split('\n');
  if (lines[c.line - 1] === c.quote) return { state: 'exact', line: c.line };
  const hits = lines.flatMap((l, i) => (l === c.quote ? [i + 1] : []));
  if (!hits.length || !c.quote.trim()) return { state: 'outdated' };
  return { state: 'moved', line: hits.reduce((best, n) => (Math.abs(n - c.line) < Math.abs(best - c.line) ? n : best)) };
}
