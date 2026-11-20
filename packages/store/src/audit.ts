import { ForgeError, verifyChain, verifyLogAnchors, type ChainProblem } from '@specforge/core';
import { LOG_ANCHOR_REF, readLogAnchors, writeLogAnchor, type GitLogAnchor } from '@specforge/runner';
import { stateHash, withStoreLock, type Store } from './store.ts';

function inspectLog(store: Store, trustedCommit?: string) {
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
  const lastByChange = new Map(events.filter((event) => event.changeId && event.stateHash)
    .map((event) => [event.changeId!, event]));
  const loaded = store.listChanges().map((id) => [id, store.load(id)] as const);
  const outOfBand = loaded.flatMap(([changeId, state]) => {
    const last = lastByChange.get(changeId);
    if (!last) return [{ changeId, problem: '没有任何事件记录' }];
    return last.stateHash === stateHash(state) ? [] : [{ changeId, problem: `最后一次记录是事件 #${last.seq}` }];
  });
  const usersProblem = store.usersOutOfBand() ?? null;
  const head = events.at(-1);
  const result = {
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
  return { result, states: loaded.map(([, state]) => state) };
}

export const verifyLog = withStoreLock(function verifyLog(store: Store, trustedCommit?: string) {
  return inspectLog(store, trustedCommit).result;
});

export const readAuditedStates = withStoreLock(function readAuditedStates(store: Store) {
  const { result, states } = inspectLog(store);
  if (!result.ok) throw new ForgeError('question_work_unavailable', '项目审计校验异常，暂不能读取问题');
  return states;
});

export const anchorLog = withStoreLock(function anchorLog(store: Store): { anchor: GitLogAnchor; created: boolean } {
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
});
