import { ForgeError, verifyChain, verifyLogAnchors, type ChainProblem } from '@specforge/core';
import { LOG_ANCHOR_REF, readLogAnchors, writeLogAnchor, type GitLogAnchor } from '@specforge/runner';
import type { Store } from './store.ts';

export function verifyLog(store: Store, trustedCommit?: string) {
  const events = store.events();
  const chainProblems = verifyChain(events);
  const anchorProblems: ChainProblem[] = [];
  let anchors: GitLogAnchor[] = [];
  try {
    anchors = readLogAnchors(store.root);
    anchorProblems.push(...verifyLogAnchors(events, anchors));
    if (trustedCommit !== undefined) anchorProblems.push(...verifyLogAnchors(events, readLogAnchors(store.root, trustedCommit)));
  } catch (error) {
    anchorProblems.push({ seq: 0, problem: error instanceof Error ? error.message : String(error) });
  }
  const outOfBand = store.listChanges().flatMap((changeId) => {
    const problem = store.outOfBand(changeId);
    return problem ? [{ changeId, problem }] : [];
  });
  const usersProblem = store.usersOutOfBand() ?? null;
  const head = events.at(-1);
  return {
    ok: !chainProblems.length && !anchorProblems.length && !outOfBand.length && !usersProblem,
    events: events.length,
    head: head ? { seq: head.seq, hash: head.hash } : null,
    chainProblems,
    outOfBand,
    usersProblem,
    anchors: {
      ref: LOG_ANCHOR_REF,
      status: anchorProblems.length ? 'failed' : anchors.length || trustedCommit !== undefined ? 'passed' : 'unverified',
      count: anchors.length,
      latest: anchors.at(-1) ?? null,
      problems: anchorProblems,
    },
  };
}

export function anchorLog(store: Store): { anchor: GitLogAnchor; created: boolean } {
  const result = verifyLog(store);
  if (!result.ok) {
    const details = [...result.chainProblems, ...result.anchors.problems, ...result.outOfBand].map((item) => item.problem);
    if (result.usersProblem) details.push(result.usersProblem);
    throw new ForgeError('log_invalid', `日志校验失败，拒绝锚定：${details.join('；')}`);
  }
  if (!result.head) throw new ForgeError('no_events', '事件日志为空，没有可锚定的事件');
  if (result.anchors.latest?.seq === result.head.seq) return { anchor: result.anchors.latest, created: false };
  const anchor = writeLogAnchor(store.root, { version: 1, ...result.head, at: new Date().toISOString() }, result.anchors.latest?.commit);
  return { anchor, created: true };
}
