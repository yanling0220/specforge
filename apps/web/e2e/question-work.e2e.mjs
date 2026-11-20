import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { addUser, createQuestion, emptyAnalysis, ForgeError, sha256, rotateToken } from '@specforge/core';
import { defaultConfig, questionAction, readInbox, readQuestionWork, Store, verifyLog } from '@specforge/store';
import { headSha } from '@specforge/runner';
import { startServer } from '../../server/src/server.ts';
import { chrome } from './chrome.mjs';

const dev = { name: 'dev-fixture', role: 'dev' };
const pm = { name: 'product-fixture', role: 'product' };
const fixtureToken = (actor) => actor.name + '-local-test';
const quote = JSON.stringify;
const route = (number) => '#/changes/demo/analysis/Q-' + number;
const select = (selector) => 'document.querySelector(' + quote(selector) + ')';
const contains = (selector, text) => 'contains(' + quote(selector) + ', ' + quote(text) + ')';

function fixture(root) {
  mkdirSync(join(root, '.specforge'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.name=fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture');
  const config = defaultConfig();
  writeFileSync(join(root, '.specforge/config.json'), JSON.stringify(config));
  const store = new Store(root);
  store.mutateUsers(dev, 'user.added', (registry) => addUser(registry, { name: dev.name, roles: [dev.role], admin: true }, sha256(fixtureToken(dev)), undefined, 'T'), {});
  store.mutateUsers(dev, 'user.added', (registry) => addUser(registry, { name: pm.name, roles: [pm.role] }, sha256(fixtureToken(pm)), dev, 'T'), {});
  const create = (id, input) => createQuestion({ id, category: '业务规则', severity: 'blocking', raisedAtStage: 'analysis', ...input }, config, dev, '2026-11-01T12:00:00Z');
  const questions = [
    create('Q-1', { question: '导入遇到重复邮箱如何处理？' }),
    create('Q-2', { question: '导入历史保留多久？', options: [{ id: 'a', text: '保留 7 天', impact: '节省存储' }, { id: 'b', text: '保留 30 天', impact: '便于复查' }] }),
    create('Q-3', { question: '导入失败需要展示哪些结果？' }),
    create('Q-4', { question: '导入成功提示显示什么？', severity: 'minor' }),
    create('Q-5', { question: '技术题，仅开发可见', category: '技术方案' }),
  ];
  questions[4].requiredRoles = ['dev'];
  store.create({ change: { id: 'demo', title: '批量导入体验验收', baseSha: headSha(root), tier: 'M', stage: 'analysis', createdAt: 'T', createdBy: dev },
    analysis: emptyAnalysis(config), questions, reviews: [], approvals: [] }, dev);
  questionAction(store, 'demo', dev, 'Q-1', { kind: 'answer', text: '跳过重复邮箱并报告受影响行' });
  questionAction(store, 'demo', dev, 'Q-3', { kind: 'answer', text: '只显示成功数和失败数' });
  return store;
}

async function available(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      if (error.code !== 'write_busy' || attempt >= 20) throw error;
      await sleep(50);
    }
  }
}

async function flow(browser, server, store) {
  const { evaluate, send, wait, click } = browser;
  const go = (hash) => browser.go(server.url + '/' + hash);
  const field = (selector, value) => evaluate('setField(' + select(selector) + ', ' + quote(value) + '), true');
  const has = (selector) => '!!' + select(selector);
  const clickLink = (selector) => evaluate(select(selector) + '.click(), true');
  const enter = async (actor, hash) => {
    await go(hash);
    await wait(has('form.login'), '项目登录');
    await field('form.login input:not([type=password])', actor.name);
    await field('form.login input[type=password]', fixtureToken(actor));
    await click('登录');
    await wait(contains('.me', actor.name), '角色登录完成');
  };
  const logout = async () => { await click('退出'); await wait(has('form.login'), '退出'); };
  const receipt = (text) => wait(contains('.work-receipt', text), text);
  const draft = '.answer-editor textarea';
  const input = (value) => field(draft, value);
  const question = (number) => '.question-work-item a[href$="/Q-' + number + '"]';
  const checkHistory = () => available(() => verifyLog(store));

  await enter(pm, '#/inbox');
  await wait(contains('.inbox-list', '重复邮箱') + ' && ' + contains('.inbox-list', '成功数和失败数'), '产品从摘要识别两项确认');
  assert.equal(await evaluate(has(question(5))), false);
  await field('.inbox-toolbar select', 'confirm');
  await wait('document.querySelectorAll(".question-work-item").length === 2', '待本角色确认筛选');
  await clickLink(question(1));
  await wait(contains('.answer-current', '跳过重复邮箱'), '核对完整答案');
  await click('确认此答案');
  await receipt('已确认第 1 版');
  await wait(has('.work-receipt a[href$="/Q-3"]'), '确认后继续同筛选下的 Q-3');
  await clickLink('.work-receipt a[href$="/Q-3"]');
  await click('退回并要求修订');
  await field('.answer-current textarea', '需要逐行列出失败原因');
  await click('提交');
  await receipt('已退回第 1 版');
  await clickLink('.work-receipt a[href="#/inbox"]');
  await wait(contains('main', '当前筛选下没有问题') + ' && document.activeElement.tagName === "SELECT"', '返回恢复筛选并将焦点移到筛选框');
  assert.equal(await evaluate(select('.inbox-toolbar select') + '.value'), 'confirm');
  await field('.inbox-toolbar select', '');
  await wait(contains('[data-question-status="revise"]', '需要逐行列出失败原因') + ' && ' + has(question(2)) + ' && ' + has(question(4)), '退回进入修订，未答事项仍可见');

  await clickLink(question(2));
  await wait(has('.answer-editor select'), '标准选项选择');
  await field('.answer-editor select', 'option:b');
  await wait(contains('.answer-preview', '保留 30 天'), '按选项预览正文');
  await click('提交答案');
  await receipt('已提交第 1 版答案，等待开发确认');
  assert.equal(await available(() => store.load('demo').questions[1].revisions[0].text), '保留 30 天');

  await go(route(3));
  await wait(select(draft) + '?.value === "只显示成功数和失败数"', '退回题回填上一版正文');
  await input('逐行列出错误原因和行号');
  await wait(contains('.answer-editor', '草稿已保存在此标签页'), '实际保存草稿');
  await clickLink('.crumbs a[href="#/inbox"]');
  await wait(has(question(3)), '返回列表');
  await clickLink(question(3));
  await wait(select(draft) + '?.value === "逐行列出错误原因和行号"', '返回恢复草稿');
  await send('Page.reload');
  await wait(select(draft) + '?.value === "逐行列出错误原因和行号"', '刷新恢复草稿');
  await click('提交新版本');
  await receipt('已提交第 2 版答案，等待开发确认');
  await wait(contains('.history', '需要逐行列出失败原因'), '历史保留退回意见');
  assert.equal(await available(() => store.load('demo').questions[2].revisions[0].state), 'rejected');

  await go(route(4));
  await wait(has(draft), '打开 Q-4');
  await evaluate('window.originalStorageSave = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error("fixture quota"); }; true');
  await input('保存失败时仍保留的正文');
  await wait(contains('.answer-editor', '浏览器未能保存草稿'), '存储失败明确反馈');
  assert.equal(await evaluate(select(draft) + '.value'), '保存失败时仍保留的正文');
  await evaluate('const oldConfirm = window.confirm; window.confirm = () => false; ' + select('.crumbs a') + '.click(); window.confirm = oldConfirm; true');
  assert.equal(await evaluate('location.hash'), route(4), '拒绝离开后留在问题');
  await evaluate('Storage.prototype.setItem = window.originalStorageSave; true');
  await input('产品的并发草稿');

  const before = await available(() => store.events().length);
  await available(() => questionAction(store, 'demo', dev, 'Q-4', { kind: 'answer', text: '开发先提交了成功提示' }));
  await click('提交答案');
  await wait(contains('.answer-editor', '问题已更新') + ' && ' + contains('.answer-current', '开发先提交'), '旧基准触发冲突并展示最新答案');
  assert.equal(await evaluate(select(draft) + '.value'), '产品的并发草稿');
  assert.equal(await available(() => store.events().length), before + 1);
  assert.equal(await evaluate('!!button("提交新版本")'), false, '核对前不可重发');
  await click('已核对，继续编辑草稿');

  await evaluate(`window.realFetch = window.fetch; window.fetch = (...args) => window.realFetch(...args).then((response) => {
    if (String(args[0]).endsWith('/submit-answer') && response.ok) throw new TypeError('fixture lost response');
    return response;
  }); true`);
  const beforeLost = await available(() => store.events().length);
  await click('提交新版本');
  await wait(contains('.error', '未能确认提交结果') + ' && ' + contains('.answer-current', '产品的并发草稿'), '丢失响应时核对已落盘的答案');
  await evaluate('window.fetch = window.realFetch; true');
  assert.equal(await available(() => store.events().length), beforeLost + 1);
  assert.equal(await evaluate(select(draft) + '.value'), '产品的并发草稿');

  const sync = server.index.sync.bind(server.index);
  server.index.sync = () => { throw new ForgeError('index_unavailable', '合成索引故障'); };
  try {
    await click('刷新问题');
    await wait(contains('.error', '合成索引故障') + ' && !button("提交新版本")', '索引故障停用写入并保留草稿');
  } finally { server.index.sync = sync; }
  await click('重试读取问题');
  await wait('!!button("已核对提交结果")', '读取恢复可核对提交结果');
  await click('已核对提交结果');

  await available(() => store.mutateUsers(dev, 'user.token_reset', (registry) => rotateToken(registry, pm.name, sha256('new-local-fixture-token'), dev, 'T'), {}));
  await server.tick();
  await wait(has('form.login'), '登录会话撤销后返回登录页');
  assert.equal(await evaluate('Object.keys(sessionStorage).filter((k) => k.startsWith("specforge.question-draft:")).length'), 0);
  await enter(dev, route(4));
  await wait(contains('.answer-current', '产品的并发草稿'), '开发通过旧深链接核对新版');
  assert.equal(await evaluate(has(draft)), false, '产品草稿未进入开发会话');
  await click('确认此答案');
  await receipt('已确认第 2 版');
  await go('#/inbox');
  await wait(has(question(5)) + ' && ' + contains('.inbox-list', '保留 30 天'), '开发收到交接且能看到技术题');
  await clickLink(question(2));
  await click('确认此答案');
  await receipt('已确认第 1 版');
  await logout();
  const audit = await checkHistory();
  assert.equal(audit.ok, true);
  console.log('问题工作台 Chrome 四题流程通过 · ' + audit.events + ' 条事件');
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'specforge-ux2-'));
  let browser, server;
  try {
    const store = fixture(join(work, 'project'));
    server = await startServer({ store, port: 0, pollMs: 60_000 });
    browser = await chrome(work);
    await flow(browser, server, store);
    const measurements = await available(() => store.exclusive(() => {
      const measure = (read) => {
        const start = performance.now();
        const value = read();
        return { lockMs: +(performance.now() - start).toFixed(2), bytes: Buffer.byteLength(JSON.stringify(value)) };
      };
      return { questionWork: measure(() => readQuestionWork(store, dev)), inbox: measure(() => ({ role: dev.role, items: readInbox(store, dev) })) };
    }));
    console.log('小型样例读取 ' + JSON.stringify(measurements));
  } finally {
    try { await browser?.close(); }
    finally {
      try { await server?.close(); }
      finally { rmSync(work, { recursive: true, force: true }); }
    }
  }
}

await main();
