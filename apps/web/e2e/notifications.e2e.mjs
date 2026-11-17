// 两类通知的真实 Chrome 验收；所有 IM 请求均注入，不连接飞书或模型。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addUser, confirmRestatement, createQuestion, emptyAnalysis, parseNotificationConfig,
  proposeAnswer, setRestatement, sha256,
} from '@specforge/core';
import { git, headSha } from '@specforge/runner';
import { defaultConfig, NotificationLedger, questionAction, recordReview, Store, verifyLog } from '@specforge/store';
import { startMultiProjectServer, startServer } from '../../server/src/server.ts';

const work = mkdtempSync(join(tmpdir(), 'sf-notify-browser-'));
const chromePath = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const processes = [];
const servers = [];
const browsers = [];
const previousEnv = new Map();
const dev = { name: 'dev', role: 'dev' };
const pm = { name: 'pm', role: 'product' };
const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration));
const step = (message) => console.log('▶ ' + message);
async function available(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      if (error.code !== 'write_busy' || attempt >= 30) throw error;
      await sleep(100);
    }
  }
}
async function until(predicate, label, duration = 15000) {
  for (const start = Date.now(); Date.now() - start < duration; await sleep(75)) {
    if (await predicate()) return;
  }
  throw new Error('等待超时：' + label);
}
function project(mode, id, ready) {
  const root = join(work, mode + '-' + id);
  mkdirSync(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['commit', '--allow-empty', '-qm', 'init']);
  mkdirSync(join(root, '.specforge'), { recursive: true });
  const config = { ...defaultConfig(), protectedPaths: [], testGlobs: [], verify: [{ name: 'test', command: 'test' }] };
  writeFileSync(join(root, '.specforge/config.json'), JSON.stringify(config));
  const store = new Store(root);
  store.mutateUsers(dev, 'user.added', (users) => addUser(users, { name: 'dev', roles: ['dev'], admin: true }, sha256('dev-' + id), undefined, 'T'), {});
  store.mutateUsers(dev, 'user.added', (users) => addUser(users, { name: 'pm', roles: ['product'] }, sha256('pm-' + id), dev, 'T'), {});
  const change = (changeId, stage) => ({ id: changeId, title: id + '-private-title', tier: 'S', stage, baseSha: headSha(root), createdAt: 'T', createdBy: dev });
  const question = createQuestion({ id: 'Q-1', question: id + '-private-question', category: '业务规则', severity: 'minor', raisedAtStage: 'analysis' }, config, dev, 'T');
  store.create({ change: change('same', 'analysis'), analysis: emptyAnalysis(config), questions: [proposeAnswer(question, { text: id + '-private-answer' }, dev, 'T')], reviews: [], approvals: [] }, dev);
  if (ready) {
    store.create({ change: change('ready', 'closing'), analysis: confirmRestatement(setRestatement(emptyAnalysis(config), 'ready'), dev, 'T'), questions: [], reviews: [], approvals: [] }, dev);
    const sha = headSha(root);
    store.saveEvidence('ready', {
      id: 'ev-ready', sha, startedAt: 'T', finishedAt: 'T', mainTreeDirty: false,
      steps: [{ name: 'test', command: 'test', exitCode: 0, timedOut: false, durationMs: 1, outputTail: '# tests 1\n', outputHash: sha256('# tests 1\n') }],
      host: { node: process.version, platform: process.platform },
    }, dev);
    const reviewer = { name: 'reviewer', role: 'agent' };
    recordReview(store, 'ready', reviewer, { kind: 'agent', sha, verdict: 'pass', reviewer, at: 'T', coverage: ['change'], findings: [] }, {}, () => {});
  }
  return store;
}
function settings(id, mount) {
  const webhookEnv = 'SF_NOTIFY_BROWSER_' + id.toUpperCase() + '_HOOK';
  const signingSecretEnv = 'SF_NOTIFY_BROWSER_' + id.toUpperCase() + '_SECRET';
  for (const [key, value] of [[webhookEnv, 'https://open.feishu.cn/open-apis/bot/v2/hook/' + id.repeat(32)], [signingSecretEnv, 'fake-signing-secret']]) {
    if (!previousEnv.has(key)) previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  return {
    projectId: id, enabled: true, provider: 'feishu', alias: '项目 ' + id,
    publicBaseUrl: 'https://console.example.invalid' + mount, webhookEnv, signingSecretEnv,
    route: { id: id + '-team', provider: 'feishu', revision: 'v1', members: [{ name: 'dev', memberId: 'ou_' + id + '_dev' }, { name: 'pm', memberId: 'ou_' + id + '_pm' }] },
  };
}

async function connectBrowser(label) {
  const profile = join(work, 'chrome-' + label);
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
  const responses = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true });
    if (message.method === 'Network.webSocketCreated') sockets.push(message.params.url);
    if (message.method === 'Network.requestWillBeSent') requests.push({ url: message.params.request.url, method: message.params.request.method });
    if (message.method === 'Network.responseReceived') responses.push({ path: new URL(message.params.response.url).pathname, status: message.params.response.status });
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
    window.__read = async (url) => {
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(url);
        const body = await response.json();
        if (response.status !== 409 || body.error?.code !== 'write_busy' || attempt >= 20) return { status: response.status, body };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
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
  return { send, evaluate, sockets, requests, responses, close: () => socket.close() };
}

async function scenario(multi) {
  const label = multi ? 'multi' : 'single';
  const mount = multi ? '/console/team' : '/console/single';
  step(label + '：注入捕获两类真实 worker 消息，验证最小内容及深链接');
  const a = project(label, 'a', true);
  const b = multi ? project(label, 'b', false) : undefined;
  const sent = [];
  const transport = async (webhook, body) => { sent.push({ webhook, body: JSON.parse(body) }); return { status: 200, code: 0, retryAfter: null }; };
  const notifications = parseNotificationConfig({ version: 1, projects: [settings('a', mount), ...(multi ? [settings('b', mount)] : [])] });
  const options = { port: 0, basePath: mount, notifications, notificationTransport: transport };
  const server = multi ? await startMultiProjectServer({ ...options, projects: [{ id: 'a', root: a.root }, { id: 'b', root: b.root }] }) : await startServer({ ...options, store: a });
  servers.push(server);
  await until(() => sent.length === (multi ? 3 : 2), '两类通知受理');
  const ledger = new NotificationLedger(a, { projectId: 'a' });
  await until(() => available(() => ledger.list().every((record) => record.status === 'accepted')), '发送结果落盘');
  assert.equal(sent.length, multi ? 3 : 2);
  const own = sent.filter((entry) => entry.webhook.endsWith('a'.repeat(32)));
  const nodes = (entry) => entry.body.content.post.zh_cn.content.flat();
  const question = own.find((entry) => nodes(entry).some((node) => node.tag === 'a' && node.href.includes('/analysis/')));
  const signoff = own.find((entry) => nodes(entry).some((node) => node.tag === 'a' && node.href.endsWith('/changes/ready')));
  assert.ok(question && signoff);
  assert.deepEqual(nodes(question).filter((node) => node.tag === 'at').map((node) => node.user_id), ['ou_a_pm']);
  assert.deepEqual(nodes(signoff).filter((node) => node.tag === 'at').map((node) => node.user_id), ['ou_a_dev']);
  assert.ok(!JSON.stringify(sent).includes('private-'));
  const prefix = mount + (multi ? '/p/a' : '');
  const localLink = (entry) => {
    const address = new URL(nodes(entry).find((node) => node.tag === 'a').href);
    assert.equal(address.origin, 'https://console.example.invalid');
    return new URL(server.url).origin + address.pathname + address.hash;
  };
  const browser = await connectBrowser(label); browsers.push(browser);
  const { send, evaluate } = browser;
  const wait = (expression, label) => until(async () => {
    try { return await evaluate(expression); }
    catch (error) { if (/context|navigat/i.test(error.message)) return false; throw error; }
  }, label);
  const go = async (address) => { await send('Page.navigate', { url: address }); await wait('!!window.__btn && location.href === ' + JSON.stringify(address), '页面导航'); };
  const login = async (name, id) => {
    await wait("!!document.querySelector('form.login')", '登录页');
    await evaluate("(() => { const [name, token] = document.querySelectorAll('form.login input'); __set(name, " + JSON.stringify(name) + "); __set(token, " + JSON.stringify(name + '-' + id) + "); __btn('登录').click(); return true; })()");
    await wait("!!document.querySelector('.me')", '本人登录');
  };
  const post = (path, body) => evaluate('fetch(' + JSON.stringify(path) + ', { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(' + JSON.stringify(body) + ') }).then(async (response) => ({ status: response.status, body: await response.json() }))');
  const initial = await available(() => a.events());
  await go(localLink(question));
  await login('pm', 'a');
  await wait("!!document.querySelector('#q-Q-1.selected')", '通知保留问题深链接');
  assert.deepEqual(await available(() => a.events()), initial, '打开通知和登录不写事件');
  assert.equal(await evaluate('location.pathname'), prefix + '/');
  const old = await available(() => a.load('same').questions[0].revisions.at(-1));
  await evaluate("__btn('以 product 身份确认', document.querySelector('#q-Q-1')).click(), true");
  await wait("!!document.querySelector('#q-Q-1 form.action-form')", '确认表单');
  await available(() => questionAction(a, 'same', dev, 'Q-1', { kind: 'answer', text: 'a-private-answer-v2' }));
  await wait("document.querySelector('#q-Q-1 .history')?.textContent.includes('a-private-answer-v2') && !document.querySelector('#q-Q-1 form.action-form')", '最新答案关闭旧表单');
  const beforeStale = await available(() => a.events().length);
  const stale = await post(prefix + '/api/changes/same/questions/Q-1/confirm', { role: 'product', rev: old.rev, answerHash: old.hash });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'stale_answer');
  assert.equal(await available(() => a.events().length), beforeStale);
  await evaluate("__btn('以 product 身份确认', document.querySelector('#q-Q-1')).click(), true");
  await wait("!!document.querySelector('#q-Q-1 form.action-form')", '新版确认表单');
  await evaluate("__btn('提交', document.querySelector('#q-Q-1 form')).click(), true");
  await wait("!!document.querySelector('#q-Q-1 .st-confirmed')", '新版本人确认');
  const confirmed = await available(() => a.load('same').questions[0].revisions.at(-1));
  assert.equal(confirmed.rev, 2);
  assert.deepEqual(confirmed.confirmations.find((entry) => entry.role === 'product').actor, pm);
  assert.equal(confirmed.confirmations.find((entry) => entry.role === 'product').recordedBy, undefined);
  if (multi) {
    const beforeB = await available(() => ({ events: b.events(), state: b.load('same') }));
    const denied = await evaluate('fetch(' + JSON.stringify(mount + '/p/b/api/changes') + ').then((response) => response.status)');
    assert.equal(denied, 401, 'A 会话不能访问 B');
    const messageB = sent.find((entry) => entry.webhook.endsWith('b'.repeat(32)));
    await go(localLink(messageB)); await login('pm', 'b');
    await wait("!!document.querySelector('#q-Q-1.selected')", 'B 保留通知深链接');
    assert.ok(!(await evaluate('document.body.innerText')).includes('a-private-'));
    assert.deepEqual(await available(() => ({ events: b.events(), state: b.load('same') })), beforeB);
  }
  step(label + '：签字消息进入正确变更，product 无签字权，dev 登录后绑定当前 HEAD');
  const beforeSignoff = await available(() => a.events());
  await go(localLink(signoff));
  await wait("!!document.querySelector('.me') && !!document.querySelector('.action-bar')", '签字变更');
  assert.equal(await evaluate('location.hash'), '#/changes/ready');
  assert.deepEqual(await available(() => a.events()), beforeSignoff);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '签字通过').disabled"), true);
  const denied = await post(prefix + '/api/changes/ready/signoff', { role: 'product', verdict: 'pass' });
  assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'bad_role');
  const forged = await post(prefix + '/api/changes/ready/signoff', { role: 'dev', verdict: 'pass' });
  assert.equal(forged.status, 403); assert.equal(forged.body.error.code, 'role_not_granted');
  assert.deepEqual(await available(() => a.events()), beforeSignoff);
  await evaluate("__btn('退出').click(), true");
  await login('dev', 'a');
  assert.equal(await evaluate('location.hash'), '#/changes/ready');
  await wait("!!__btn('签字通过')", '开发者签字按钮');
  await evaluate("__btn('签字通过').click(), true");
  await until(() => available(() => a.load('ready').reviews.some((review) => review.kind === 'human')), '开发者签字落盘');
  const review = await available(() => a.load('ready').reviews.find((entry) => entry.kind === 'human'));
  assert.deepEqual(review.reviewer, dev); assert.equal(review.sha, headSha(a.root)); assert.equal(review.verdict, 'pass');
  assert.equal(await available(() => a.load('ready').change.stage), 'closing', '提醒和签字不自动推进流程');
  await server.tick();
  if (!multi) await server.notifications.tick();
  const ids = sent.map((entry) => nodes(entry).filter((node) => node.tag === 'text').map((node) => node.text).find((text) => text.startsWith('通知 ')).split(' · ')[0]);
  assert.equal(new Set(ids).size, ids.length, 'accepted 的同键通知不能重复发送');
  assert.ok(browser.sockets.length > 0);
  assert.ok(browser.sockets.every((address) => new URL(address).pathname.startsWith(mount + '/')));
  assert.ok(!browser.requests.some((request) => request.url.startsWith('https://open.feishu.cn/')));
  await server.close(); servers.splice(servers.indexOf(server), 1);
  browser.close(); browsers.splice(browsers.indexOf(browser), 1);
  for (const store of [a, ...(b ? [b] : [])]) {
    assert.equal(verifyLog(store).ok, true);
    console.log(label + ' ' + (store === a ? 'a' : 'b') + ': ' + store.events().length + ' 条事件，链 / 状态 / 名册一致');
  }
  console.log('✅ ' + label + ' 两类通知深链接、身份校验与去重通过（注入传输 ' + sent.length + ' 次，无真实 IM）');
}

try { await scenario(false); await scenario(true); }
catch (error) { console.error('❌', error.stack); process.exitCode = 1; }
finally {
  browsers.forEach((browser) => browser.close());
  await Promise.all(servers.map((server) => server.close()));
  await Promise.all(processes.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited; clearTimeout(timer);
  }));
  for (const [key, value] of previousEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(work, { recursive: true, force: true });
}
