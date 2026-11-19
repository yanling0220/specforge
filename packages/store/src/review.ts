import { realpathSync } from 'node:fs';
import { acIdsOf, buildReviewAcTrace, classifyReviewRecords, evaluateReview, ForgeError, globToRegExp, hashOf, parseSpec, parseTasks } from '@specforge/core';
import { listReviewTree, readReviewDiff, readReviewFileDiff, readReviewHead, readReviewTreeBlobs, ReviewDiffError, type ReviewDiffManifest, type ReviewTreeEntry } from '@specforge/runner';
import type { Stage } from '@specforge/shared';
import { verifyLog } from './audit.ts';
import { stateHash, withStoreLock, type Store } from './store.ts';

type ReadFailure = 'unavailable' | 'too_large' | 'timeout';
type Area<T> = { status: 'complete'; data: T } | { status: ReadFailure | 'not_available' };

function stale(): never {
  throw new ForgeError('review_stale', '审查快照已变化，请刷新');
}

function tooLarge(): never {
  throw new ForgeError('review_too_large', '审查响应超过 4 MiB');
}

function reviewError(error: unknown): never {
  if (error instanceof ForgeError && ['no_change', 'not_found', 'review_stale', 'review_too_large',
    'review_not_available', 'review_timeout', 'recovery_required', 'write_busy'].includes(error.code)) throw error;
  if (error instanceof ReviewDiffError) {
    if (error.code === 'review_stale') stale();
    if (error.code === 'not_found') throw new ForgeError('not_found', error.message);
    if (error.code === 'too_large') throw new ForgeError('review_too_large', error.message);
    if (error.code === 'timeout') throw new ForgeError('review_timeout', error.message);
  }
  throw new ForgeError('review_unavailable', '审查快照暂不可用');
}

async function readArea<T>(read: () => Promise<T>): Promise<Area<T>> {
  try { return { status: 'complete', data: await read() }; }
  catch (error) {
    if (!(error instanceof ReviewDiffError) || error.code === 'review_stale') reviewError(error);
    return { status: error.code === 'too_large' || error.code === 'timeout' ? error.code : 'unavailable' };
  }
}

function committedStage(stage: Stage): boolean {
  return stage === 'implement' || stage === 'closing' || stage === 'delivered';
}

const RESPONSE_BYTES = 4 * 1024 * 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Validate the file-backed authority and bind the version to inputs, not evaluation time. */
function facts(store: Store, changeId: string, projectBinding: string, targetSha: string | null) {
  const state = store.load(changeId);
  const audit = verifyLog(store);
  if (!audit.ok || state.change.id !== changeId || store.outOfBand(changeId, state)) {
    throw new ForgeError('review_unavailable', '审查快照暂不可用');
  }
  const config = store.config();
  const { baseSha } = state.change;
  const evidence = targetSha === null ? [] : store.evidenceIndex(changeId, (event) =>
    event.type === 'tdd.recorded' || event.payload.sha === targetSha || event.payload.sha === baseSha)
    .map((entry) => ({ ...entry, scope: entry.kind === 'tdd' ? 'task' as const
      : entry.sha === targetSha && entry.sha === baseSha ? 'target_and_baseline' as const
        : entry.sha === targetSha ? 'target' as const : 'baseline' as const }));
  const snapshotVersion = hashOf({
    repository: realpathSync(store.root), projectBinding, changeId, baseSha, targetSha,
    state: stateHash(state), eventHead: audit.head, config, anchor: audit.anchors.latest?.commit ?? null, evidence,
  });
  return { state, config, evidence, snapshotVersion };
}

async function capture(store: Store, changeId: string, projectBinding: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(changeId)) throw new ForgeError('no_change', '变更不存在');
  const available = committedStage(store.load(changeId).change.stage);
  const targetSha = available ? await readReviewHead(store.root) : null;
  return { targetSha, ...facts(store, changeId, projectBinding, targetSha) };
}

async function confirmVersion(store: Store, changeId: string, projectBinding: string, targetSha: string | null, expected: string) {
  if (facts(store, changeId, projectBinding, targetSha).snapshotVersion !== expected) stale();
  if (targetSha !== null) await readReviewHead(store.root, targetSha);
}

function readSources(store: Store, sha: string, entries: ReviewTreeEntry[], maxFiles: number) {
  if (entries.length > maxFiles) throw new ReviewDiffError('too_large');
  return readReviewTreeBlobs(store.root, sha, entries);
}

async function readTrace(store: Store, changeId: string, sha: string, testGlobs: string[]) {
  const tree = await readArea(async () => {
    const tree = await listReviewTree(store.root, sha);
    if (tree.unavailablePaths) throw new ReviewDiffError('unavailable');
    return tree.files;
  });
  if (tree.status !== 'complete') return { specs: tree, tasks: tree, tests: tree };
  const prefix = 'openspec/changes/' + changeId;
  const specs = await readArea(async () => {
    const entries = tree.data.filter(({ path }) => path.startsWith(prefix + '/specs/') && path.endsWith('/spec.md'));
    const sources = await readSources(store, sha, entries, 200);
    return sources.map(({ path, text }) => parseSpec(path, text));
  });
  const tasks = await readArea(async () => {
    const path = prefix + '/tasks.md';
    const [source] = await readSources(store, sha, tree.data.filter((file) => file.path === path), 1);
    return source ? parseTasks(path, source.text) : null;
  });
  const ids = new Set(specs.status === 'complete' ? acIdsOf(specs.data) : []);
  const tests = ids.size === 0 ? { status: 'not_available' as const } : await readArea(async () => {
    if (!Array.isArray(testGlobs) || testGlobs.some((glob) => typeof glob !== 'string')) throw new ReviewDiffError('unavailable');
    const globs = testGlobs.map(globToRegExp);
    const sources = await readSources(store, sha, tree.data.filter(({ path }) => globs.some((glob) => glob.test(path))), 1_000);
    const references = new Map<string, string[]>();
    for (const { path, text } of sources) {
      const inFile = new Set(Array.from(text.matchAll(/\[(AC-\d+)\]/g), (match) => match[1]!));
      for (const id of inFile) {
        if (!ids.has(id)) continue;
        const paths = references.get(id);
        if (paths) paths.push(path);
        else references.set(id, [path]);
      }
    }
    return { fileCount: sources.length, references };
  });
  return { specs, tasks, tests };
}

const notAvailable = { status: 'not_available' } as const;

/** Captures one review view with the same repository lease used by platform writers. */
export const readReviewSnapshot = withStoreLock(async function readReviewSnapshot(store, changeId: string, projectBinding: string) {
  try {
    const { state, targetSha, config, snapshotVersion, evidence } = await capture(store, changeId, projectBinding);
    const { baseSha, stage } = state.change;
    if (bytes(state.reviews) + bytes(evidence) > RESPONSE_BYTES) tooLarge();

    const diff: Area<ReviewDiffManifest> = targetSha === null ? notAvailable : await readArea(() =>
      readReviewDiff({ repo: store.root, projectBinding, changeId, baseSha, expectedTargetSha: targetSha }));
    const { specs, tasks, tests } = targetSha === null
      ? { specs: notAvailable, tasks: notAvailable, tests: notAvailable }
      : await readTrace(store, changeId, targetSha, config.testGlobs);
    const parsedSpecs = specs.status === 'complete' ? specs.data : [];
    const parsedTasks = tasks.status === 'complete' ? tasks.data : null;
    const { records, latest } = classifyReviewRecords(targetSha ?? undefined, state.reviews,
      acIdsOf(parsedSpecs), state.questions.map(({ id }) => id));
    const acTrace = buildReviewAcTrace(parsedSpecs, parsedTasks ?? undefined,
      tests.status === 'complete' ? tests.data.references : new Map(), { records, latest });
    const summary = {
      changeId, stage, snapshotVersion, baseSha, targetSha, available: targetSha !== null, workingTreeExcluded: true as const,
      diff: diff.status === 'complete' ? { status: diff.status, ...diff.data } : diff,
      reports: records, latestReports: latest,
      reviewGate: targetSha === null ? null : evaluateReview(targetSha, state.reviews, new Date().toISOString()),
      trace: {
        specs: { status: specs.status, fileCount: parsedSpecs.length },
        tasks: { status: tasks.status, fileCount: parsedTasks ? 1 : 0 },
        tests: { status: tests.status, fileCount: tests.status === 'complete' ? tests.data.fileCount : 0 },
      },
      evidence,
    };
    // Check each row before serializing the response. Repeated ACs can share
    // references in memory but repeat them in the response.
    let size = bytes(summary) + 13; // ,"acTrace":[]
    if (size > RESPONSE_BYTES) tooLarge();
    for (const row of acTrace) {
      size += bytes(row) + 1;
      if (size > RESPONSE_BYTES) tooLarge();
    }
    await confirmVersion(store, changeId, projectBinding, targetSha, snapshotVersion);
    return { ...summary, acTrace };
  } catch (error) { reviewError(error); }
});

export type ReviewSnapshot = Awaited<ReturnType<typeof readReviewSnapshot>>;

export const readReviewFileSnapshot = withStoreLock(async function readReviewFileSnapshot(
  store, changeId: string, fileId: string, snapshotVersion: string, projectBinding: string,
) {
  if (!/^[a-f0-9]{64}$/.test(snapshotVersion)) throw new ForgeError('bad_arg', 'snapshot 必须是审查快照的版本号');
  try {
    const { state, targetSha, snapshotVersion: current } = await capture(store, changeId, projectBinding);
    if (current !== snapshotVersion) stale();
    if (targetSha === null) throw new ForgeError('review_not_available', '当前阶段尚无提交审查视图');
    const file = await readReviewFileDiff({ repo: store.root, projectBinding, changeId, baseSha: state.change.baseSha, targetSha, fileId });
    await confirmVersion(store, changeId, projectBinding, targetSha, snapshotVersion);
    const response = { snapshotVersion, file };
    if (bytes(response) > RESPONSE_BYTES) tooLarge();
    return response;
  } catch (error) { reviewError(error); }
});

export type ReviewFileSnapshot = Awaited<ReturnType<typeof readReviewFileSnapshot>>;
