import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { addUser, confirmRestatement, emptyAnalysis, setRestatement, sha256 } from '@specforge/core';
import { headSha, runVerification } from '@specforge/runner';
import { defaultConfig, recordReview, Store, verifyLog } from '@specforge/store';
import { startMultiProjectServer, startServer } from '../../server/src/server.ts';

import { chrome } from './chrome.mjs';
const dev = { name: 'dev', role: 'dev' };
const product = { name: 'product', role: 'product' };
const reviewer = { name: 'fixture-reviewer', role: 'agent' };
const route = '#/changes/same';
const endpoint = '/api/changes/same/review';
const relativeSpec = 'openspec/changes/same/specs/demo/spec.md';
const relativeTest = 'tests/example.test.cjs';
const codePath = 'src/审查 <literal>.js';
const binaryPath = 'src/data.bin';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = JSON.stringify;

async function whenIdle(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      if (error.code !== 'write_busy' || attempt >= 30) throw error;
      await sleep(100);
    }
  }
}

function write(root, path, content) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function record(store, sha, note, findings = []) {
  recordReview(store, 'same', reviewer, {
    kind: 'agent', sha, reviewer, verdict: 'pass', at: new Date().toISOString(),
    coverage: ['AC-1'], note, findings,
  }, {}, () => {});
}

function verify(store, sha) {
  const result = runVerification({ repo: store.root, sha, steps: store.config().verify });
  assert.match(result.steps[0].outputTail, /# pass 1\b/);
  assert.equal(result.steps[0].exitCode, 0);
  store.saveEvidence('same', result, dev);
  return result.id;
}

function fixture(work, id) {
  const root = join(work, id);
  mkdirSync(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'review-e2e@example.invalid');
  git(root, 'config', 'user.name', 'Review E2E');
  write(root, '.gitignore', '/.specforge/\n');
  write(root, codePath, '// baseline\n');
  write(root, relativeTest, 'require("node:test")("fixture ran", () => {});\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'baseline');
  const base = headSha(root);
  const config = { ...defaultConfig(), verify: [{ name: 'test', command: 'node --test tests/example.test.cjs', timeoutMs: 10_000 }] };
  delete config.audit;
  write(root, '.specforge/config.json', JSON.stringify(config));
  const store = new Store(root);
  for (const actor of [dev, product]) {
    store.mutateUsers(dev, 'user.added', (users) => addUser(users, {
      name: actor.name, roles: [actor.role], admin: actor === dev,
    }, sha256(actor.name + '-' + id), dev, new Date().toISOString()), {});
  }
  const at = new Date().toISOString();
  const analysis = emptyAnalysis(config);
  store.create({
    change: { id: 'same', title: 'Review fixture ' + id, tier: 'S', stage: 'closing', baseSha: base, createdAt: at, createdBy: dev },
    analysis: { ...confirmRestatement(setRestatement(analysis, 'Review two output formats'), dev, at),
      dimensions: analysis.dimensions.map((dimension) => ({ ...dimension, status: 'covered' })) },
    questions: [], reviews: [], approvals: [],
  }, dev);
  record(store, base, id + '-historical-report');
  const marker = id + '-source-marker';
  write(root, codePath, '// ' + marker + ' <span data-fixture="literal">plain text</span>\n');
  write(root, binaryPath, Buffer.from([0, 1, 2]));
  write(root, relativeSpec, '## ADDED Requirements\n### Requirement: Output\nSystem SHALL format output.\n'
    + '#### Scenario: [AC-1] Plain\n- **WHEN** requested\n- **THEN** plain text\n'
    + '#### Scenario: [AC-2] Binary\n- **WHEN** requested\n- **THEN** bytes\n');
  write(root, 'openspec/changes/same/tasks.md', '- [x] T-1 Format output (AC-1, AC-2)\n');
  write(root, relativeTest, '// [AC-1] [AC-2]\nrequire("node:test")("fixture ran", () => {});\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'review target');
  const target = headSha(root);
  verify(store, base);
  const evidence = verify(store, target);
  record(store, target, id + '-current-report', [
    { severity: 'blocking', anchor: 'AC-1', text: id + '-blocking-finding' },
    { severity: 'non-blocking', text: id + '-other-finding' },
  ]);

  write(root, 'tests/staged.test.cjs', '// STAGED_ONLY\n');
  git(root, 'add', 'tests/staged.test.cjs');
  write(root, codePath, '// WORKTREE_ONLY\n');
  write(root, 'tests/untracked.test.cjs', '// UNTRACKED_ONLY\n');
  return { id, root, store, base, target, marker, evidence };
}

function fingerprint({ root, store }) {
  const files = Object.fromEntries(readdirSync(store.path(''), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => {
      const file = join(entry.parentPath, entry.name);
      return [store.rel(file), sha256(readFileSync(file, 'utf8'))];
    }));
  return {
    head: headSha(root), index: readFileSync(join(root, '.git/index')), files,
    worktree: [codePath, 'tests/staged.test.cjs', 'tests/untracked.test.cjs'].map((path) => readFileSync(join(root, path))),
    anchor: git(root, 'for-each-ref', 'refs/heads/specforge-audit'),
  };
}

const contains = (selector, text) => 'contains(' + quote(selector) + ', ' + quote(text) + ')';
const exists = (selector) => '!!document.querySelector(' + quote(selector) + ')';
const settled = '!!button("刷新审查")';
const patch = '.review-patch';
const selectFile = async (browser, path) => {
  const item = '[...document.querySelectorAll(".review-files button")].find((b) => b.textContent.includes(' + quote(path) + '))';
  await browser.wait(settled + ' && !!' + item, '文件清单 ' + path);
  await browser.evaluate(item + '.click(), true');
};

async function login(browser, actor, project) {
  await browser.wait(exists('form.login'), '登录页');
  await browser.evaluate('(() => { const [name, token] = document.querySelectorAll("form.login input"); '
    + 'setField(name, ' + quote(actor.name) + '); setField(token, ' + quote(actor.name + '-' + project.id)
    + '); button("登录").click(); return true; })()');
  await browser.wait(contains('.me', actor.name), '登录成功');
}

function commitNext(project, content) {
  write(project.root, codePath, '// ' + content + '\n');
  git(project.root, 'add', '--', codePath);
  git(project.root, 'commit', '-q', '-m', content, '--', codePath);
  return headSha(project.root);
}

async function inspectReview(browser, project, base) {
  const { evaluate, wait } = browser;
  await wait(contains('.review-range', project.target) + ' && ' + settled, '提交范围载入');
  assert.equal(await evaluate(contains('.review-range', project.base)), true);
  assert.equal(await evaluate(contains('.review-gate', 'G6B · 未通过')), true);
  assert.equal(await evaluate(contains('#review-report-2', '报告通过')), true);
  const fileUrl = base + endpoint + '/files/';
  assert.equal(browser.requests.some(({ url }) => url.startsWith(fileUrl)), false, '文件只在选择时读取');
  await selectFile(browser, codePath);
  await wait(contains(patch, project.marker), '文本差异');
  assert.match(await evaluate('document.querySelector(".review-patch").textContent'), /\s1\s+-\/\/ baseline\n\s+1\s+\+\/\/ /);
  assert.equal(await evaluate(exists('[data-fixture="literal"]')), false, '差异标记按纯文本渲染');
  assert.doesNotMatch(await evaluate('document.querySelector(".review").innerText'), /STAGED_ONLY|WORKTREE_ONLY|UNTRACKED_ONLY|staged\.test|untracked\.test/);
  await selectFile(browser, binaryPath);
  await wait(contains('.review-file-detail', '二进制文件'), '二进制大小');
  assert.equal(await evaluate(exists(patch)), false);

  await evaluate('setField(document.querySelector(".review-filter select"), "blocking"), true');
  await wait(contains('#review-report-2', project.id + '-blocking-finding') + ' && !'
    + contains('#review-report-2', project.id + '-other-finding'), '阻塞发现项筛选');
  await evaluate('setField(document.querySelector(".review-filter input"), "ac-2"), true');
  await wait('document.querySelectorAll(".review-table tbody tr").length === 1 && ' + contains('.review-table tbody', 'AC-2'), 'AC 筛选');
  assert.equal(await evaluate(contains('.review-table tbody', relativeTest)), true);
  await evaluate('document.querySelector(".review-history summary").click(), true');
  await wait(contains('.review-history[open]', project.id + '-historical-report'), '展开历史报告');

  const evidenceUrl = base + '/' + route + '/evidence/' + project.evidence;
  await evaluate('document.querySelector("#review-evidence a[href$=" + CSS.escape(' + quote(project.evidence) + ') + "]").click(), true');
  await wait('location.href === ' + quote(evidenceUrl) + ' && ' + contains('.output', '# pass 1'), '证据页保持项目及前缀');
  await browser.go(base + '/' + route + '/review');
  await wait(settled, '返回审查');
}

async function refreshAndRecover(browser, project, base) {
  const { evaluate, wait, send, responses } = browser;
  const priorFile = [...browser.requests].reverse().find(({ url }) => url.startsWith(base + endpoint + '/files/'));
  const next = commitNext(project, project.id + '-external-commit');
  await selectFile(browser, codePath);
  await wait(contains('.review-range', next) + ' && !' + exists(patch) + ' && ' + settled, '文件版本过期后自动刷新');
  if (!responses.some(({ url, status }) => url.startsWith(base + endpoint + '/files/') && status === 409)) {
    assert.ok(priorFile, '需要先捕获旧快照的文件请求');
    // 补查和文件点击可能同时发生。即使补查先更新了页面，仍要验证旧引用被拒绝。
    const response = await evaluate(`(async () => {
      for (let attempt = 0; ; attempt++) {
        const result = await fetch(${quote(priorFile.url)}, { cache: 'no-store' });
        const error = (await result.json()).error?.code;
        if (error !== 'write_busy' || attempt >= 10) return { status: result.status, error };
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    })()`);
    assert.deepEqual(response, { status: 409, error: 'review_stale' });
  }
  await selectFile(browser, codePath);
  await wait(contains(patch, project.id + '-external-commit'), '重新选择后显示当前差异');

  const polled = commitNext(project, project.id + '-poll-commit');
  await wait(contains('.review-range', polled) + ' && !' + exists(patch) + ' && ' + settled, '无业务事件的提交由补查捕获', 23_000);
  await selectFile(browser, codePath);
  await wait(contains(patch, project.id + '-poll-commit'), '补查后的差异');
  const before = fingerprint(project);
  await send('Network.setBlockedURLs', { urls: [base + endpoint] });
  await browser.click('刷新审查');
  await wait(exists('.review [role="alert"]') + ' && !' + exists('.review-range') + ' && !'
    + exists(patch) + ' && !' + exists('.review-report') + ' && !' + exists('.review-table'), '读取失败清除旧差异、报告和追溯');
  await send('Network.setBlockedURLs', { urls: [] });
  await browser.click('刷新审查');
  await wait(contains('.review-range', polled) + ' && ' + settled, '手动刷新恢复');
  assert.deepEqual(fingerprint(project), before);
  return polled;
}

async function signoff(browser, project, base, sha) {
  const { evaluate, wait } = browser;
  const { store } = project;
  const evidence = await whenIdle(() => store.exclusive(() => {
    const id = verify(store, sha);
    record(store, sha, project.id + '-event-refresh');
    return id;
  }));
  await wait(contains('#review-report-3', project.id + '-event-refresh') + ' && ' + settled, 'WebSocket 刷新报告', 12_000);
  await wait('document.querySelector("#review-evidence a[href$=" + CSS.escape(' + quote(evidence) + ') + "]") !== null', '显示新验证证据');
  await evaluate('document.querySelector(".review-toolbar a").click(), true');
  await wait('location.href === ' + quote(base + '/' + route) + ' && !!button("签字通过")', '审查跳转现有门禁');
  await browser.go(base + '/#/inbox/approvals');
  const inbox = '[data-inbox-kind="human-signoff"] a';
  await wait(exists(inbox), '开发者收件箱显示待签字');
  await evaluate('document.querySelector(' + quote(inbox) + ').click(), true');
  await browser.click('签字通过');
  await wait(exists('.gate-card.passed') + ' && [...document.querySelectorAll(".gate-card.passed")].some((g) => g.textContent.includes("G6B"))', '门禁完成当前 HEAD 签字');
  const signed = await whenIdle(() => store.load('same').reviews.at(-1));
  assert.deepEqual(signed?.reviewer, dev);
  assert.equal(signed?.sha, sha);
  await browser.go(base + '/#/inbox/approvals');
  await wait(contains('main', '当前角色暂无其他审批待处理') + ' && !' + exists(inbox), '签字后待办消失');
}

async function browserSuite(multiProject) {
  const work = mkdtempSync(join(tmpdir(), 'sf-review-e2e-'));
  let browser;
  let server;
  try {
    const a = fixture(work, multiProject ? 'alpha' : 'single');
    const b = multiProject ? fixture(work, 'beta') : undefined;
    server = b ? await startMultiProjectServer({
      projects: [a, b].map(({ id, root }) => ({ id, root })), basePath: '/console/team', port: 0,
    }) : await startServer({ store: a.store, port: 0 });
    browser = await chrome(work);
    const base = (project) => b ? server.url + '/p/' + project.id : server.url;

    console.log('▶ ' + (b ? '前缀双项目' : '根路径单项目') + '读取审查、筛选、历史与证据');
    const beforeA = fingerprint(a);
    await browser.go(base(a) + '/' + route + '/review');
    await login(browser, b ? product : dev, a);
    await inspectReview(browser, a, base(a));
    assert.deepEqual(fingerprint(a), beforeA);
    assert.equal(browser.requests.some(({ method, url }) => method === 'POST' && url.includes('/api/changes/')), false);
    if (b) {
      await browser.evaluate('document.querySelector(".review-toolbar a").click(), true');
      await browser.wait('[...document.querySelectorAll(".action-bar button")].some(b => b.textContent === "签字通过" && b.disabled)', '产品可读审查，但签字按钮禁用');
      await browser.go(base(a) + '/' + route + '/review');
      await selectFile(browser, codePath);
      await browser.wait(contains(patch, a.marker), '切换前显示 A 补丁');
      const beforeB = fingerprint(b);
      const status = await browser.evaluate('fetch(' + quote(base(b) + endpoint) + ').then(response => response.status)');
      assert.equal(status, 401, 'A 会话不能读取 B');
      await browser.go(base(b) + '/' + route + '/review');
      await browser.wait(exists('form.login') + ' && !' + exists(patch), 'B 需要独立登录且没有 A 的差异');
      await login(browser, dev, b);
      await inspectReview(browser, b, base(b));
      await selectFile(browser, codePath);
      await browser.wait(contains(patch, b.marker), 'B 展示自己的同名文件');
      assert.equal(await browser.evaluate(contains('main', a.marker)), false);
      await browser.click('退出');
      await browser.wait(exists('form.login') + ' && !' + exists('.review'), '退出清除审查页');
      assert.deepEqual(fingerprint(b), beforeB);
      await browser.go(base(a) + '/' + route + '/review');
      await browser.wait(settled, 'B 退出后 A 仍可读');
      assert.deepEqual(fingerprint(a), beforeA);
    }

    console.log('▶ 旧版本失效、无事件补查和断网恢复');
    const sha = await refreshAndRecover(browser, a, base(a));
    if (b) {
      await browser.click('退出');
      await login(browser, dev, a);
    }
    console.log('▶ 事件刷新、收件箱和现有门禁签字');
    await signoff(browser, a, base(a), sha);
    for (const project of b ? [a, b] : [a]) {
      const audit = await whenIdle(() => verifyLog(project.store));
      assert.equal(audit.ok, true);
      assert.equal(audit.anchors.count, 0);
      const events = await whenIdle(() => project.store.events());
      assert.equal(events.some(({ type }) => type.startsWith('notification.')), false);
      console.log(project.id + ' 哈希链、状态与名册一致 · ' + audit.events + ' 条事件');
    }
  } finally {
    try { await browser?.close(); }
    finally {
      try { await server?.close(); }
      finally { rmSync(work, { recursive: true, force: true }); }
    }
  }
}

try {
  await browserSuite(false);
  await browserSuite(true);
  console.log('✅ 代码审查 Chrome 集成验收通过');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
