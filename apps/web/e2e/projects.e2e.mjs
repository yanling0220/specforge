import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addUser, createQuestion, emptyAnalysis, proposeAnswer, sha256 } from '@specforge/core';
import { headSha } from '@specforge/runner';
import { defaultConfig, Store } from '@specforge/store';

const repository = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const chromePath = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const work = mkdtempSync(join(tmpdir(), 'sf-projects-e2e-'));
const processes = [];
const admin = { name: 'same', role: 'dev' };
const deepLink = '#/changes/same/analysis/Q-1';
const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration));
const step = (message) => console.log(`▶ ${message}`);
const sf = (root, ...args) => available(() => execFileSync(process.execPath, [join(repository, 'apps/cli/src/main.ts'), ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' }));
let browser;

async function available(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      if (attempt >= 30 || (error.code !== 'write_busy' && !String(error.stderr).includes('仓库正在执行其他操作'))) throw error;
      await sleep(100);
    }
  }
}

function project(id) {
  const root = join(work, id);
  mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  writeFileSync(join(root, 'code.js'), 'export const value = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  mkdirSync(join(root, '.specforge/changes'), { recursive: true });
  writeFileSync(join(root, '.specforge/config.json'), JSON.stringify(defaultConfig()));
  const store = new Store(root);
  store.mutateUsers(admin, 'user.added', (registry) => addUser(registry, { name: 'same', roles: ['dev', 'product'], admin: true }, sha256(`token-${id}`), undefined, 'T'), {});
  store.create({ change: { id: 'same', title: `${id}-private-title`, tier: 'M', stage: 'analysis', baseSha: headSha(root), createdAt: 'T', createdBy: admin }, analysis: emptyAnalysis(defaultConfig()), questions: [], reviews: [], approvals: [] }, admin);
  store.mutate('same', admin, 'question.raised', (state) => ({ ...state, questions: [createQuestion({ id: 'Q-1', question: `${id}-private-question`, category: '业务规则', severity: 'blocking', raisedAtStage: 'analysis' }, store.config(), admin, 'T')] }), () => ({ questionId: 'Q-1' }));
  store.mutate('same', admin, 'question.answered', (state) => ({ ...state, questions: state.questions.map((question) => proposeAnswer(question, { text: `${id}-private-answer` }, admin, 'T')) }), () => ({ questionId: 'Q-1' }));
  store.saveEvidence('same', { id: 'ev-1', sha: headSha(root), startedAt: 'T', finishedAt: 'T', mainTreeDirty: false, steps: [{ name: 'test', command: 'test', exitCode: 0, timedOut: false, durationMs: 1, outputTail: `${id}-private-evidence`, outputHash: sha256(id) }], host: { node: process.version, platform: process.platform } }, admin);
  return store;
}

async function connectBrowser() {
  const profile = join(work, 'chrome');
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1300,1000', 'about:blank'], { stdio: 'ignore' });
  processes.push(chrome);
  let target;
  for (let attempt = 0; attempt < 100 && !target; attempt++) {
    await sleep(100);
    const portFile = join(profile, 'DevToolsActivePort');
    if (!existsSync(portFile)) continue;
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    target = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).then((targets) => targets.find((entry) => entry.type === 'page')).catch(() => undefined);
  }
  if (!target) throw new Error('Chrome 没有启动');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map();
  const sockets = [];
  const requests = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Network.webSocketCreated') sockets.push(message.params.url);
    if (message.method === 'Network.requestWillBeSent') requests.push({ url: message.params.request.url, method: message.params.request.method });
    if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++sequence;
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP 超时：${method}`)); }, 15000);
    pending.set(requestId, (message) => { clearTimeout(timeout); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await send('Page.enable');
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__documentId = crypto.randomUUID();
    window.__sockets = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) { super(...args); window.__sockets.push(this); this.messages = []; this.addEventListener('message', (event) => this.messages.push(JSON.parse(event.data))); }
    };
    window.__btn = (text, scope = document) => [...scope.querySelectorAll('button')].find((button) => button.textContent.trim() === text && !button.disabled);
    window.__set = (element, value) => {
      const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };
  ` });
  return { send, evaluate, sockets, requests, close: () => socket.close() };
}

async function main() {
  step('准备两个同名用户 / change / Q / 证据 / 事件序号的真实 Git 项目');
  const first = project('a');
  const second = project('b');
  const secondBefore = { state: second.load('same'), events: second.events() };
  assert.equal(first.events().length, second.events().length);
  const registry = join(work, 'projects.json');
  writeFileSync(registry, JSON.stringify({ version: 1, projects: [{ id: 'a', root: first.root }, { id: 'b', root: second.root }] }));
  const server = spawn(process.execPath, [join(repository, 'apps/server/src/main.ts'), '--projects', registry, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(server);
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('服务启动超时')), 15000);
    server.stdout.on('data', (data) => { output += data; const address = output.split('SpecForge 多项目服务：')[1]?.split('（')[0]; if (address) { clearTimeout(timeout); resolve(address); } });
    server.on('error', reject);
    server.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`服务退出：${code}`)); });
  });
  browser = await connectBrowser();
  const { send, evaluate, sockets, requests } = browser;
  const waitFor = async (expression, description, duration = 10000) => {
    for (const started = Date.now(); Date.now() - started < duration; await sleep(100)) {
      try { if (await evaluate(expression)) return; } catch (error) { if (!/context|navigat/i.test(error.message)) throw error; }
    }
    throw new Error(`等待超时：${description}\n${await evaluate('document.body.innerText.slice(0, 1000)')}`);
  };
  const go = async (path) => { await send('Page.navigate', { url: `${base}${path}` }); await waitFor(`location.href === ${JSON.stringify(`${base}${path}`)} && !!window.__btn`, '页面导航'); };
  const noOtherData = async (id) => {
    const text = await evaluate('document.body.innerText');
    assert.ok(!text.includes(`${id}-private-`), `页面不得显示 ${id} 的业务数据`);
    assert.ok(!text.includes(first.root) && !text.includes(second.root), '页面不得显示仓库路径');
  };
  const login = async (id) => {
    await waitFor(`!!document.querySelector('form.login:not(.project-entry)')`, '项目登录');
    await evaluate(`(() => { const [name, token] = document.querySelectorAll('form.login input'); __set(name, 'same'); __set(token, ${JSON.stringify(`token-${id}`)}); __btn('登录').click(); return true; })()`);
    await waitFor(`!!document.querySelector('.me') && !!document.querySelector('#q-Q-1.selected')`, '本人登录并保留问题深链接');
  };
  const selectRole = async (role) => { await evaluate(`__set(document.querySelector('.role-picker'), ${JSON.stringify(role)}), true`); };
  const openConfirmation = async () => {
    await waitFor(`!!__btn('以 product 身份确认', document.querySelector('#q-Q-1'))`, '本人确认按钮');
    await evaluate(`__btn('以 product 身份确认', document.querySelector('#q-Q-1')).click(), true`);
    await waitFor(`!!document.querySelector('#q-Q-1 form.action-form')`, '确认表单');
  };
  const switchEntry = async () => {
    await evaluate(`document.querySelector('.project-switch').click(), true`);
    await waitFor(`!!document.querySelector('.project-entry') && !document.body.innerText.includes('正在重新核对权限')`, '项目入口');
  };
  const recent = async (id) => {
    await waitFor(`[...document.querySelectorAll('.project-link')].some((link) => link.textContent === ${JSON.stringify(id)})`, '权限复核后的访问记录');
    await evaluate(`[...document.querySelectorAll('.project-link')].find((link) => link.textContent === ${JSON.stringify(id)}).click(), true`);
    await waitFor(`location.pathname === '/p/${id}/' && !!document.querySelector('.me')`, '切换项目');
  };

  step('根入口不枚举项目；A 深链接独立登录，A 的凭据不能访问 B');
  await go('/');
  await waitFor(`!!document.querySelector('.project-entry')`, '通用入口');
  assert.equal(await evaluate(`document.querySelectorAll('.project-link').length`), 0);
  await noOtherData('a'); await noOtherData('b');
  await go(`/p/a/${deepLink}`);
  await login('a');
  assert.equal(await evaluate(`document.querySelector('.role-picker').value`), 'dev');
  const denied = await evaluate(`Promise.all([fetch('/p/b/api/changes'), fetch('/p/b/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'same', token: 'token-a' }) })]).then((responses) => responses.map((response) => response.status))`);
  assert.deepEqual(denied, [401, 401]);
  await selectRole('product');
  await openConfirmation();
  await evaluate(`__set(document.querySelector('#q-Q-1 form input'), 'unsent-a-draft'), true`);
  const firstDocument = await evaluate('__documentId');
  const postCount = requests.filter((request) => request.method === 'POST' && /questions/.test(request.url)).length;
  await switchEntry();
  await evaluate(`__set(document.querySelector('.project-entry input'), 'b'); __btn('打开项目').click(); true`);
  await waitFor(`location.pathname === '/p/b/' && !!document.querySelector('form.login')`, 'B 仍需独立登录');
  await noOtherData('a');
  await go(`/p/b/${deepLink}`);
  await login('b');
  assert.notEqual(await evaluate('__documentId'), firstDocument);
  assert.equal(await evaluate(`document.querySelector('.role-picker').value`), 'dev');
  assert.equal(await evaluate(`document.querySelectorAll('form.action-form').length`), 0);
  assert.equal(requests.filter((request) => request.method === 'POST' && /questions/.test(request.url)).length, postCount);
  await noOtherData('a');

  step('同名证据、门禁、事件和 WebSocket 均绑定 B；断线只用 B 游标');
  await waitFor(`__sockets.some((socket) => socket.messages.some((message) => message.type === 'hello'))`, 'B 订阅');
  const initialSocket = new URL(sockets.at(-1));
  assert.equal(initialSocket.pathname, '/p/b/ws');
  assert.equal(initialSocket.searchParams.has('after'), false);
  const lastSequence = await evaluate(`__sockets.at(-1).messages.find((message) => message.type === 'hello').lastSeq`);
  const socketCount = sockets.length;
  await evaluate(`__sockets.at(-1).close(), true`);
  await waitFor(`__sockets.length > 1 && __sockets.at(-1).messages.some((message) => message.type === 'hello')`, 'B 断线重连');
  assert.ok(sockets.length > socketCount);
  assert.equal(new URL(sockets.at(-1)).searchParams.get('after'), String(lastSequence));
  await go('/p/b/#/changes/same/evidence/ev-1');
  await waitFor(`document.querySelector('.output')?.textContent === 'b-private-evidence'`, 'B 证据');
  await noOtherData('a');
  await go('/p/b/#/changes/same');
  await waitFor(`document.querySelectorAll('.gate-card').length > 0 && document.querySelector('h1')?.textContent.includes('b-private-title')`, 'B 门禁');
  await go('/p/b/#/events');
  await waitFor(`!!document.querySelector('.timeline .ev-head')`, 'B 时间线');
  const timeline = await evaluate(`fetch('/p/b/api/events').then((response) => response.json())`);
  assert.equal(timeline.events.length, (await available(() => second.events())).length);
  await noOtherData('a');
  await go(`/p/b/${deepLink}`);
  await waitFor(`!!document.querySelector('#q-Q-1')`, 'B 问题');
  await switchEntry();
  await recent('a');
  await waitFor(`!!document.querySelector('#q-Q-1.selected')`, '恢复 A 原问题深链接');
  assert.equal(await evaluate('location.hash'), deepLink);
  assert.equal(await evaluate(`document.querySelector('.role-picker').value`), 'dev');
  assert.equal(await evaluate(`document.querySelectorAll('form.action-form').length`), 0);
  assert.equal(new URL(sockets.at(-1)).pathname, '/p/a/ws');
  assert.equal(new URL(sockets.at(-1)).searchParams.has('after'), false);

  step('外部 CLI 修订关闭 A 旧表单，409 拒绝旧引用，本人只确认新版且 B 不变');
  await selectRole('product');
  await openConfirmation();
  const oldAnswer = await available(() => first.load('same').questions[0].revisions.at(-1));
  await sf(first.root, 'q', 'answer', 'same', 'Q-1', '--text', 'a-private-answer-v2', '--as', 'same:dev');
  await waitFor(`document.querySelector('#q-Q-1 .history')?.textContent.includes('a-private-answer-v2') && !document.querySelector('#q-Q-1 form.action-form')`, '实时修订关闭旧确认表单');
  const beforeConflict = await available(() => first.events().length);
  const stale = await evaluate(`fetch('/p/a/api/changes/same/questions/Q-1/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify({ role: 'product', rev: oldAnswer.rev, answerHash: oldAnswer.hash })}) }).then(async (response) => ({ status: response.status, body: await response.json() }))`);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'stale_answer');
  assert.equal(await available(() => first.events().length), beforeConflict);
  await openConfirmation();
  await evaluate(`__btn('提交', document.querySelector('#q-Q-1 form')).click(), true`);
  await waitFor(`!!document.querySelector('#q-Q-1 .st-confirmed')`, 'A 本人确认');
  const current = await available(() => first.load('same').questions[0].revisions.at(-1));
  assert.equal(current.rev, 2);
  const confirmation = current.confirmations.find((entry) => entry.role === 'product');
  assert.deepEqual(confirmation.actor, { name: 'same', role: 'product' });
  assert.equal(confirmation.recordedBy, undefined);
  assert.deepEqual(await available(() => second.exclusive(() => ({ state: second.load('same'), events: second.events() }))), secondBefore);

  step('旧文档延迟响应与历史返回不恢复旧表单；未知 / 损坏项目不回退');
  await evaluate(`__btn('修改答案', document.querySelector('#q-Q-1')).click(), true`);
  await evaluate(`__set(document.querySelector('#q-Q-1 textarea'), 'old-a-form'); window.__late = fetch('/p/a/api/changes/same').then((response) => response.json()).then((data) => new Promise((resolve) => setTimeout(() => resolve(data), 1500))).then(() => { document.body.dataset.late = 'a'; }); true`);
  await switchEntry();
  await recent('b');
  await sleep(1800);
  assert.equal(await evaluate(`document.body.dataset.late ?? null`), null);
  assert.equal(await evaluate(`document.querySelectorAll('form.action-form').length`), 0);
  await noOtherData('a');
  await evaluate('history.back(), true');
  await waitFor(`!!document.querySelector('.project-entry')`, '历史返回入口');
  await evaluate('history.back(), true');
  await waitFor(`location.pathname === '/p/a/' && !!document.querySelector('.me')`, '历史返回 A');
  assert.equal(await evaluate(`document.querySelectorAll('form.action-form').length`), 0);
  assert.equal(await evaluate(`document.querySelector('.role-picker').value`), 'dev');
  await go('/p/missing/');
  await waitFor(`!!document.querySelector('.error') && !!document.querySelector('.project-switch')`, '未知项目通用错误');
  await noOtherData('a'); await noOtherData('b');
  const configFile = first.path('config.json');
  const config = readFileSync(configFile, 'utf8');
  try {
    writeFileSync(configFile, 'broken-secret-config');
    await go(`/p/a/${deepLink}`);
    await waitFor(`!!document.querySelector('.error') && !!document.querySelector('.project-switch')`, 'A 损坏但仍可切换');
    await noOtherData('a');
    assert.equal(await evaluate(`document.body.innerText.includes('broken-secret-config')`), false);
    await switchEntry();
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.project-link')].map((link) => link.textContent)`), ['b']);
    await recent('b');
    await waitFor(`!!document.querySelector('#q-Q-1')`, 'B 健康');
  } finally { writeFileSync(configFile, config); }

  step('A 登出 / 重置令牌移除控制台与入口记录，不影响 B 会话');
  await go(`/p/a/${deepLink}`);
  await waitFor(`!!document.querySelector('.me')`, '恢复 A');
  await evaluate(`__btn('退出').click(), true`);
  await waitFor(`!!document.querySelector('form.login')`, 'A 登出');
  await switchEntry();
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.project-link')].map((link) => link.textContent)`), ['b']);
  await go(`/p/a/${deepLink}`);
  await login('a');
  await waitFor(`__sockets.some((socket) => socket.messages.some((message) => message.type === 'hello'))`, 'A 已连接订阅');
  await sf(first.root, 'user', 'token', 'same', '--as', 'same:dev');
  await waitFor(`!!document.querySelector('form.login') && !document.querySelector('.me')`, '令牌撤销后关闭控制台');
  await switchEntry();
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.project-link')].map((link) => link.textContent)`), ['b']);
  await recent('b');
  await waitFor(`document.querySelector('#q-Q-1 .qtext')?.textContent === 'b-private-question'`, 'B 会话仍有效');
  await noOtherData('a');
  assert.deepEqual(await available(() => second.exclusive(() => ({ state: second.load('same'), events: second.events() }))), secondBefore);
  for (const store of [first, second]) {
    const checked = await sf(store.root, 'log', 'verify');
    assert.match(checked, /完整/);
    console.log(`${store === first ? 'a' : 'b'}: ${checked.trim()}`);
  }
  assert.ok(sockets.every((url) => ['/p/a/ws', '/p/b/ws'].includes(new URL(url).pathname)));
  console.log('✅ SQLite 多项目真实浏览器端到端测试通过');
}

main().catch((error) => { console.error('❌', error.stack); process.exitCode = 1; }).finally(async () => {
  browser?.close();
  await Promise.all(processes.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timeout);
  }));
  rmSync(work, { recursive: true, force: true });
});
