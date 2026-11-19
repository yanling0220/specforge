import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disableUser } from '@specforge/core';
import { git, headSha, repositoryLockDir } from '@specforge/runner';
import { anchorLog, type ReviewFileSnapshot, type ReviewSnapshot, type Store } from '@specforge/store';
import type { ReviewRecord } from '@specforge/shared';
import { createApp } from '../src/app.ts';
import { ForgeIndex } from '../src/index-db.ts';
import { startMultiProjectServer, type RunningMultiProjectServer } from '../src/server.ts';
import { indexActor, indexProject } from './fixtures/index-project.ts';
import { notificationProject } from './fixtures/notification-project.ts';

const hooks = vi.hoisted(() => ({ afterPatch: undefined as (() => Promise<void>) | undefined }));
vi.mock(import('@specforge/runner'), async (importOriginal) => {
  const runner = await importOriginal();
  return {
    ...runner,
    async readReviewFileDiff(...args: Parameters<typeof runner.readReviewFileDiff>) {
      const file = await runner.readReviewFileDiff(...args);
      await hooks.afterPatch?.();
      return file;
    },
  };
});

const roots: string[] = [];
const indexes: ForgeIndex[] = [];
const servers: RunningMultiProjectServer[] = [];
const changeUrl = '/api/changes/same';
const reviewUrl = changeUrl + '/review';
const reviewer = { name: 'reviewer', role: 'agent' as const };

afterEach(async () => {
  hooks.afterPatch = undefined;
  await Promise.all(servers.splice(0).map((server) => server.close()));
  indexes.splice(0).forEach((index) => index.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function write(store: Store, path: string, content: string) {
  const file = join(store.root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function commit(store: Store) {
  git(store.root, ['add', '--', 'openspec', 'tests']);
  git(store.root, ['commit', '-qm', 'add committed materials']);
  return headSha(store.root);
}

function project(options: { auth?: boolean; commitFiles?: boolean } = {}) {
  const store = options.auth ? notificationProject() : indexProject();
  roots.push(store.root);
  store.mutate('same', indexActor, 'stage.advanced', (state) => ({
    ...state, change: { ...state.change, stage: 'closing' },
  }), () => ({}));
  if (options.commitFiles !== false) {
    write(store, 'openspec/changes/same/specs/example/spec.md', '### Requirement: Import\n#### Scenario: [AC-1] Add entry\n#### Scenario: [AC-2] Reject entry\n');
    write(store, 'openspec/changes/same/tasks.md', '- [x] T-1 Import (AC-1)\n');
    write(store, 'tests/示例 test.ts', '// [AC-1] and AC-2 (without brackets)\n');
    commit(store);
  }
  return store;
}

function appFor(store: Store) {
  const index = new ForgeIndex(store);
  indexes.push(index);
  return createApp(store, index);
}

async function snapshot(response: Response): Promise<ReviewSnapshot> {
  expect(response.status).toBe(200);
  return response.json() as Promise<ReviewSnapshot>;
}

const patchUrl = (version: string, id: string) => reviewUrl + '/files/' + encodeURIComponent(id) + '?snapshot=' + version;
function testFile(view: ReviewSnapshot) {
  if (view.diff.status !== 'complete') throw new Error('Missing diff');
  const file = view.diff.files.find(({ path }) => path === 'tests/示例 test.ts');
  if (!file) throw new Error('Missing test file');
  return file;
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

function loginOptions(): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'pm', token: 'pm-token' }) };
}

async function login(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

function evidence(store: Store, id: string, sha: string) {
  store.saveEvidence('same', {
    id, sha, startedAt: 'T', finishedAt: 'T', mainTreeDirty: false, host: { node: 'v', platform: 'p' },
    steps: [{ name: 'test', command: 'fixture', exitCode: 0, timedOut: false, durationMs: 0, outputTail: '', outputHash: '' }],
  }, indexActor);
}

describe('项目提交审查 API', () => {
  it('从同一提交读取 diff、规格、任务和字面测试引用，重复 GET 不改变仓库或审计记录', async () => {
    const store = project({ auth: true });
    const app = appFor(store);
    const cookie = await login(await app.request('/api/auth/login', loginOptions()));
    const request = (url: string) => app.request(url, { headers: { cookie } });
    await expectError(await app.request(reviewUrl), 401, 'unauthorized');
    write(store, 'openspec/changes/same/tasks.md', '- [ ] T-2 Dirty (AC-2)\n');
    git(store.root, ['add', '--', 'openspec/changes/same/tasks.md']);
    write(store, 'tests/示例 test.ts', '// unstaged [AC-2]\n');
    write(store, 'tests/untracked.test.ts', '// untracked [AC-2]\n');
    const fingerprint = () => ({
      head: headSha(store.root), index: readFileSync(join(store.root, '.git/index')),
      worktree: readFileSync(join(store.root, 'tests/示例 test.ts')), state: store.load('same'), events: store.events(), users: store.users(),
      anchorRef: git(store.root, ['for-each-ref', 'refs/heads/specforge-audit']),
    });
    const before = fingerprint();
    const view = await snapshot(await request(reviewUrl));
    expect(view).toMatchObject({ stage: 'closing', targetSha: before.head, diff: { status: 'complete', baseIsAncestor: true }, workingTreeExcluded: true });
    expect(view.acTrace).toMatchObject([
      { acId: 'AC-1', spec: { scenarioLine: 2 }, tasks: [{ id: 'T-1', done: true }], testFiles: ['tests/示例 test.ts'] },
      { acId: 'AC-2', spec: { scenarioLine: 3 }, tasks: [], testFiles: [] },
    ]);
    expect((await snapshot(await request(reviewUrl))).snapshotVersion).toBe(view.snapshotVersion);
    const response = await request(patchUrl(view.snapshotVersion, testFile(view).id));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json() as ReviewFileSnapshot;
    expect(result).toMatchObject({ snapshotVersion: view.snapshotVersion, file: { kind: 'text' } });
    expect(JSON.stringify(result)).toContain('[AC-1]');
    expect(JSON.stringify(result)).not.toMatch(/unstaged|untracked/);
    expect(fingerprint()).toEqual(before);
    await expectError(await request(patchUrl(view.snapshotVersion, '0'.repeat(64))), 404, 'not_found');
    await expectError(await request(reviewUrl + '/files/' + testFile(view).id), 400, 'bad_arg');
    const signoff = await app.request(changeUrl + '/signoff', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'product', verdict: 'pass' }) });
    expect(signoff.status).toBe(403);
    store.mutateUsers(indexActor, 'user.disabled', (registry) => disableUser(registry, 'pm', '停用', indexActor, 'T'), {});
    expect((await request(reviewUrl)).status).toBe(401);
    expect((await request(patchUrl(view.snapshotVersion, testFile(view).id))).status).toBe(401);
  });

  it('展示原始 verdict 和当前 G6B，旧报告不链接到当前 AC', async () => {
    const store = project();
    const app = appFor(store);
    const target = headSha(store.root);
    const base = store.load('same').change.baseSha;
    const report = (overrides: Partial<ReviewRecord>): ReviewRecord => ({
      kind: 'agent', sha: target, verdict: 'pass', reviewer, at: 'Z', coverage: ['AC-1'], findings: [], ...overrides,
    });
    store.mutate('same', indexActor, 'review.recorded', (state) => ({ ...state, reviews: [
      report({ sha: base }), report({}),
      report({ at: 'A', coverage: [], findings: [{ text: 'blocking', anchor: 'AC-1', severity: 'blocking' }] }),
      report({ kind: 'human', reviewer: indexActor, verdict: 'fail' }),
    ] }), () => ({}));
    const view = await snapshot(await app.request(reviewUrl));
    expect(view.latestReports).toEqual({ agent: 3, human: 4 });
    expect(view.reports.map(({ disposition }) => disposition)).toEqual(['historical', 'superseded', 'current', 'current']);
    expect(view.reports[2]!.record.verdict).toBe('pass');
    expect(view.reviewGate?.checks).toEqual([
      expect.objectContaining({ id: 'agent-review', passed: false }),
      expect.objectContaining({ id: 'human-signoff', passed: false }),
    ]);
    expect(view.acTrace[0]).toMatchObject({ reviewSeqs: [4], findingRefs: [{ reviewSeq: 3, findingIndex: 1 }] });
  });

  it('证据按 SHA 和任务区分，坏证据及无 HEAD 变化的配置与审查变更均使旧版本失效', async () => {
    const store = project();
    const app = appFor(store);
    const base = store.load('same').change.baseSha;
    const sha = headSha(store.root);
    evidence(store, 'base', base);
    evidence(store, 'current', sha);
    evidence(store, 'unrelated', '1'.repeat(40));
    store.saveTddEvidence('same', {
      id: 'tdd', taskId: 'T-1', base, sha: base, testFiles: [], red: {}, green: {},
      startedAt: 'T', finishedAt: 'T', host: { node: 'v', platform: 'p' },
    }, indexActor, true);
    const initial = await snapshot(await app.request(reviewUrl));
    expect(initial.evidence).toMatchObject([
      { id: 'base', scope: 'baseline', sha: base, hashOk: true },
      { id: 'current', scope: 'target', sha, hashOk: true },
      { id: 'tdd', scope: 'task', taskId: 'T-1', sha: base, hashOk: true },
    ]);
    const oldFile = (view: ReviewSnapshot) => app.request(patchUrl(view.snapshotVersion, testFile(view).id));
    writeFileSync(join(store.changeDir('same'), 'evidence/current.json'), '{malformed');
    rmSync(join(store.changeDir('same'), 'evidence/base.json'));
    await expectError(await oldFile(initial), 409, 'review_stale');
    const afterEvidence = await snapshot(await app.request(reviewUrl));
    expect(afterEvidence.evidence.map(({ id, hashOk }) => ({ id, hashOk }))).toEqual([
      { id: 'base', hashOk: false }, { id: 'current', hashOk: false }, { id: 'tdd', hashOk: true },
    ]);
    const config = store.config();
    writeFileSync(store.path('config.json'), JSON.stringify({ ...config, testGlobs: ['different/**'] }));
    await expectError(await oldFile(afterEvidence), 409, 'review_stale');
    const afterConfig = await snapshot(await app.request(reviewUrl));
    expect(afterConfig.acTrace[0]!.testFiles).toEqual([]);
    store.mutate('same', indexActor, 'review.recorded', (state) => ({ ...state, reviews: [{
      kind: 'human', sha, verdict: 'fail', reviewer: indexActor, at: 'T', coverage: [], findings: [],
    }] }), () => ({}));
    await expectError(await oldFile(afterConfig), 409, 'review_stale');
    expect(headSha(store.root)).toBe(sha);
  });

  it('外部 Git 在 patch 读取后移动 HEAD 时，拒绝返回旧内容', async () => {
    const store = project();
    const app = appFor(store);
    const view = await snapshot(await app.request(reviewUrl));
    let didReach!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((resolve) => { didReach = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    hooks.afterPatch = () => { didReach(); return resumed; };
    const pending = Promise.resolve(app.request(patchUrl(view.snapshotVersion, testFile(view).id)));
    try {
      await Promise.race([reached, pending.then(() => { throw new Error('patch did not reach barrier'); })]);
      git(store.root, ['commit', '--allow-empty', '-qm', 'external commit']);
    } finally {
      resume();
    }
    await expectError(await pending, 409, 'review_stale');
    const next = await snapshot(await app.request(reviewUrl));
    expect(next.targetSha).toBe(headSha(store.root));
    expect(next.snapshotVersion).not.toBe(view.snapshotVersion);
  });

  it('阶段不可用、提交相同、非祖先基线、缺少基线与追溯读取超限具有不同状态', async () => {
    const store = project({ commitFiles: false });
    const app = appFor(store);
    expect(await snapshot(await app.request('/api/changes/second/review'))).toMatchObject({ available: false, targetSha: null, diff: { status: 'not_available' } });
    expect(await snapshot(await app.request(reviewUrl))).toMatchObject({ diff: { status: 'complete', files: [], baseIsAncestor: true } });
    const initialHead = headSha(store.root);
    git(store.root, ['commit', '--allow-empty', '-qm', 'baseline on another branch']);
    const other = headSha(store.root);
    git(store.root, ['checkout', '--detach', initialHead]);
    write(store, 'openspec/changes/same/specs/x/spec.md', '### Requirement: R\n#### Scenario: [AC-1] S\n');
    write(store, 'tests/oversize.test.ts', 'a'.repeat(512 * 1024 + 1));
    commit(store);
    const base = (baseSha: string) => store.mutate('same', indexActor, 'fixture.baseline', (state) => ({
      ...state, change: { ...state.change, baseSha, stage: 'delivered' },
    }), () => ({}));
    base(other);
    expect(await snapshot(await app.request(reviewUrl))).toMatchObject({
      stage: 'delivered', diff: { status: 'complete', baseIsAncestor: false }, trace: { tests: { status: 'too_large' } },
    });
    const view = await snapshot(await app.request(reviewUrl));
    if (view.diff.status !== 'complete') throw new Error('Missing diff');
    const id = view.diff.files.find((file) => file.path === 'tests/oversize.test.ts')!.id;
    await expectError(await app.request(patchUrl(view.snapshotVersion, id)), 413, 'review_too_large');
    base('7'.repeat(40));
    expect(await snapshot(await app.request(reviewUrl))).toMatchObject({ diff: { status: 'unavailable' }, reviewGate: { gate: 'G6B' } });
  });

  it('超过报告响应预算时返回 413，审计锚定、状态和 pending 异常时拒绝快照', async () => {
    const store = project({ commitFiles: false });
    const app = appFor(store);
    const anchor = anchorLog(store);
    expect(anchor.created).toBe(true);
    await snapshot(await app.request(reviewUrl));
    git(store.root, ['update-ref', 'refs/heads/specforge-audit', headSha(store.root)]);
    await expectError(await app.request(reviewUrl), 503, 'review_unavailable');
    git(store.root, ['update-ref', 'refs/heads/specforge-audit', anchor.anchor.commit]);
    const path = join(store.changeDir('same'), 'reviews.json');
    const original = readFileSync(path);
    writeFileSync(path, '[{}]');
    await expectError(await app.request(reviewUrl), 503, 'review_unavailable');
    writeFileSync(path, original);
    const pending = join(dirname(repositoryLockDir(store.root)), 'specforge-write.pending.json');
    writeFileSync(pending, '{}');
    await expectError(await app.request(reviewUrl), 503, 'recovery_required');
    expect(readFileSync(pending, 'utf8')).toBe('{}');
    rmSync(pending);
    store.mutate('same', indexActor, 'review.recorded', (state) => ({ ...state, reviews: [{
      kind: 'agent', sha: headSha(store.root), verdict: 'pass', reviewer, at: 'T', coverage: [], findings: [],
      note: 'a'.repeat(4 * 1024 * 1024),
    }] }), () => ({}));
    await expectError(await app.request(reviewUrl), 413, 'review_too_large');
  });

  it('在带前缀双项目中隔离会话、版本和同名文件 ID，损坏项目不影响另一项目', async () => {
    const a = project({ auth: true });
    const b = project({ auth: true });
    const server = await startMultiProjectServer({
      projects: [{ id: 'a', root: a.root }, { id: 'b', root: b.root }], basePath: '/console/sf', port: 0, pollMs: 60_000,
    });
    servers.push(server);
    const url = (id: string, path: string) => server.url + '/p/' + id + path;
    const ac = await login(await fetch(url('a', '/api/auth/login'), loginOptions()));
    const bc = await login(await fetch(url('b', '/api/auth/login'), loginOptions()));
    const get = (id: string, path: string, cookie: string) => fetch(url(id, path), { headers: { cookie } });
    expect((await get('b', reviewUrl, ac.replace('sf_session_a=', 'sf_session_b='))).status).toBe(401);
    const [av, bv] = [await snapshot(await get('a', reviewUrl, ac)), await snapshot(await get('b', reviewUrl, bc))];
    expect(testFile(av).id).not.toBe(testFile(bv).id);
    await expectError(await get('b', patchUrl(av.snapshotVersion, testFile(av).id), bc), 409, 'review_stale');
    await expectError(await get('b', patchUrl(bv.snapshotVersion, testFile(av).id), bc), 404, 'not_found');
    expect((await get('b', patchUrl(bv.snapshotVersion, testFile(bv).id), bc)).status).toBe(200);
    writeFileSync(a.path('events.jsonl'), 'broken-log');
    expect((await get('a', reviewUrl, ac)).status).toBe(503);
    expect((await snapshot(await get('b', reviewUrl, bc))).snapshotVersion).toBe(bv.snapshotVersion);
  });
});
