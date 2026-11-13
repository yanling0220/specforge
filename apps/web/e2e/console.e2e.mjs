// Web 控制台端到端测试（真实浏览器，T3.4）。不属于 npm test：需要本机安装 Chrome，并先 npm run web:build。
//   node apps/web/e2e/console.e2e.mjs
// 环境变量 CHROME 可指定浏览器路径。流程：
//   开发者登录 → 回答阻塞问题 → 退出 → 产品登录 → 确认 → 退出 → 开发者推进到 spec → 产品评论 spec（挡住 G2）
//   → 开发者确认评论解决 → 审批 spec → 推进到 design
//   → 推进到 tasks 被门禁拦截 → 补齐方案与任务后在任务面板接管 T-1 → 校验事件与哈希链
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 4391;
const DEBUG_PORT = 9391;
const work = mkdtempSync(join(tmpdir(), 'sf-e2e-'));
const proj = join(work, 'proj');
const procs = [];

const sf = (...args) => execFileSync('node', [join(REPO, 'apps/cli/src/main.ts'), ...args], { cwd: proj, encoding: 'utf8' });
const git = (...args) => execFileSync('git', args, { cwd: proj, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`▶ ${msg}`);

function setupProject() {
  mkdirSync(proj);
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(proj, 'a.js'), 'x\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  sf('init');
  git('add', '-A');
  git('commit', '-qm', 'specforge init');
  const dev = sf('user', 'add', 'devon', '--role', 'dev', '--admin', '--as', 'devon:dev').match(/(sf_[A-Za-z0-9_-]+)/)[1];
  const pm = sf('user', 'add', 'pam', '--role', 'product', '--as', 'devon:dev').match(/(sf_[A-Za-z0-9_-]+)/)[1];
  sf('whoami', '--set', 'devon:dev');
  sf('change', 'new', 'demo', '--title', '批量导入', '--tier', 'M');
  sf('restate', 'demo', '--text', '管理员上传 CSV 批量创建用户');
  sf('restate', 'demo', '--confirm');
  for (const d of JSON.parse(execFileSync('cat', [join(proj, '.specforge/config.json')], { encoding: 'utf8' })).dimensions) sf('dim', 'set', 'demo', d, 'covered');
  sf('q', 'add', 'demo', '--q', '能否通过导入创建管理员？', '--severity', 'blocking', '--category', '业务规则', '--option', 'A=不能，一律 member', '--option', 'B=可以');
  const spec = join(proj, 'openspec/changes/demo/specs/import/spec.md');
  mkdirSync(dirname(spec), { recursive: true });
  writeFileSync(spec, '## ADDED Requirements\n\n### Requirement: 导入\n系统 SHALL 导入用户，角色一律为 member（Q-1）。\n\n#### Scenario: [AC-1] 导入\n- **WHEN** 导入\n- **THEN** 成功\n');
  git('add', '-A');
  git('commit', '-qm', 'spec');
  return { dev, pm };
}

async function cdp() {
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${join(work, 'chrome')}`, '--window-size=1300,1000', 'about:blank'], { stdio: 'ignore' });
  procs.push(chrome);
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => undefined);
  }
  if (!target) throw new Error('Chrome 没有启动');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Page.enable');
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

// 页面内辅助：按文字找按钮、给受控输入框赋值
const HELPERS = `
window.__btn = (text, scope = document) => [...scope.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.disabled);
window.__set = (el, v) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
true;`;

async function main() {
  step('准备示例项目与用户');
  const tokens = setupProject();
  const server = spawn('node', [join(REPO, 'apps/server/src/main.ts'), '--port', String(PORT)], { cwd: proj, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(server);
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('Web 控制台：') && resolve());
    server.on('exit', (c) => reject(new Error(`server 退出：${c}`)));
  });
  const base = `http://127.0.0.1:${PORT}`;
  const { send, evaluate, close } = await cdp();

  const go = async (hash) => {
    await send('Page.navigate', { url: `${base}/${hash}` });
    await sleep(300);
    await evaluate(HELPERS);
  };
  const waitFor = async (expr, what, ms = 5000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (await evaluate(expr)) return;
    const text = await evaluate('document.body.innerText.slice(0, 600)');
    throw new Error(`等待超时：${what}\n页面内容：${text}`);
  };
  const login = async (name, token) => {
    await go('#/');
    await waitFor(`!!document.querySelector('form.login')`, '登录页');
    await evaluate(`(() => { const [u, t] = document.querySelectorAll('form.login input'); __set(u, ${JSON.stringify(name)}); __set(t, ${JSON.stringify(token)}); __btn('登录').click(); return true; })()`);
    await waitFor(`document.querySelector('.me')?.textContent.includes(${JSON.stringify(name)})`, `${name} 登录成功`);
  };
  const logout = async () => {
    await evaluate(`__btn('退出').click(), true`);
    await waitFor(`!!document.querySelector('form.login')`, '退出后回到登录页');
  };
  /** 在问题卡片 / 操作栏中点开某个操作，填写字段并提交 */
  const act = async (scopeSel, label, fill = {}) => {
    await waitFor(`!!__btn(${JSON.stringify(label)}, document.querySelector(${JSON.stringify(scopeSel)}) ?? document)`, `按钮「${label}」`);
    await evaluate(`(() => {
      const scope = document.querySelector(${JSON.stringify(scopeSel)});
      __btn(${JSON.stringify(label)}, scope).click();
      return true;
    })()`);
    await sleep(150);
    const filled = await evaluate(`(() => {
      const form = document.querySelector(${JSON.stringify(scopeSel)} + ' form.action-form');
      if (!form) return 'noform';
      const fill = ${JSON.stringify(fill)};
      for (const label of form.querySelectorAll('label')) {
        const key = Object.keys(fill).find((k) => label.textContent.startsWith(k));
        if (key) __set(label.querySelector('input, textarea, select'), fill[key]);
      }
      __btn('提交', form).click();
      return 'ok';
    })()`);
    return filled;
  };

  step('开发者登录，回答 Q-1');
  await login('devon', tokens.dev);
  await go('#/changes/demo/analysis/Q-1');
  await waitFor(`!!document.querySelector('#q-Q-1')`, '问题卡片');
  await act('#q-Q-1', '回答', { 选项: 'A', 答案: '不能，导入的用户一律为 member' });
  await waitFor(`document.querySelector('#q-Q-1 .badge.st-drafted') !== null`, 'Q-1 变为待确认');

  step('产品登录，确认 Q-1');
  await logout();
  await login('pam', tokens.pm);
  await go('#/changes/demo/analysis/Q-1');
  await act('#q-Q-1', '以 product 身份确认', { 说明: '同意' });
  await waitFor(`document.querySelector('#q-Q-1 .badge.st-confirmed') !== null`, 'Q-1 已确认');

  step('开发者推进到规格阶段');
  await logout();
  await login('devon', tokens.dev);
  await go('#/changes/demo');
  await act('.action-bar', '推进到「规格」');
  await waitFor(`document.querySelector('h1')?.textContent.includes('当前阶段：规格')`, '推进到 spec');

  step('产品不能审批 spec（按钮禁用）；开发者审批并推进');
  await logout();
  await login('pam', tokens.pm);
  await go('#/changes/demo');
  await waitFor(`!!document.querySelector('.action-bar')`, '操作栏');
  const disabled = await evaluate(`[...document.querySelectorAll('.action-bar button')].find((b) => b.textContent.includes('审批当前 spec'))?.disabled`);
  if (disabled !== true) throw new Error('产品角色的审批按钮应当禁用');
  step('产品在产物审阅中评论 spec 第 7 行；未解决的评论挡住 G2');
  await go('#/changes/demo/artifacts');
  await waitFor(`!!document.querySelector('.file-view')`, '产物审阅');
  await evaluate(`(() => { const f = [...document.querySelectorAll('.file-list button')].find((b) => b.textContent.includes('spec.md')); f.click(); return true; })()`);
  await waitFor(`document.querySelector('.file-view h2')?.textContent.includes('spec.md')`, '打开 spec.md');
  await evaluate(`(() => { [...document.querySelectorAll('.ln-btn')].find((b) => b.textContent === '7').click(); return true; })()`);
  await act('.file-view', '评论第 7 行', { '评论': 'THEN 要写具体返回值' });
  await waitFor(`document.querySelector('.comment .badge.cst-open') !== null`, '评论显示为待处理');
  await go('#/changes/demo');
  await waitFor(`[...document.querySelectorAll('.gate-card')].some((g) => g.textContent.includes('未解决：C-1'))`, 'G2 显示未解决的评论');

  step('开发者确认评论解决，审批 spec');
  await logout();
  await login('devon', tokens.dev);
  await go('#/changes/demo/artifacts');
  await evaluate(`(() => { [...document.querySelectorAll('.file-list button')].find((b) => b.textContent.includes('spec.md')).click(); return true; })()`);
  await act('.comment', '确认解决', { '说明': '口头确认，后续修订' });
  await waitFor(`document.querySelector('.comment .badge.cst-resolved') !== null`, '评论已解决');
  await go('#/changes/demo');
  await act('.action-bar', '审批当前 spec');
  await waitFor(`[...document.querySelectorAll('.gate-card')].some((g) => g.textContent.includes('G2 规格门') && g.classList.contains('passed'))`, 'G2 通过');
  await act('.action-bar', '推进到「方案」');
  await waitFor(`document.querySelector('h1')?.textContent.includes('当前阶段：方案')`, '推进到 design');

  step('推进被门禁拦截时显示原因');
  await act('.action-bar', '推进到「任务」');
  await waitFor(`document.querySelector('.action-bar .error')?.textContent.includes('门禁未通过')`, '显示拦截原因');

  step('接管：推进到任务阶段后，在任务面板接手 T-1');
  writeFileSync(join(proj, 'openspec/changes/demo/design.md'), '# 方案\n实现 AC-1。\n\n## 结构变更\n- 无：只改现有模块\n');
  writeFileSync(join(proj, 'openspec/changes/demo/tasks.md'), '- [ ] T-1 实现导入（AC-1）\n');
  git('add', '-A');
  git('commit', '-qm', 'design + tasks');
  sf('advance', 'demo');
  await go('#/changes/demo');
  await waitFor(`!!document.querySelector('.tasks-panel')`, '任务面板');
  await act('.tasks-panel', '接管', { 说明: '涉及权限，人来写' });
  await waitFor(`document.querySelector('.tasks-panel')?.textContent.includes('devon 接手')`, 'T-1 显示为 devon 接手');

  close();
  step('校验事件与哈希链');
  if (!/T-1\s+👤 devon 接手/.test(sf('task', 'list', 'demo'))) throw new Error('sf task list 中 T-1 应为 devon 接手');
  const log = sf('log', 'demo');
  for (const want of ['question.answered', 'question.confirmed', 'comment.added', 'comment.resolved', 'spec.approved', 'stage.advanced', 'stage.advance_rejected', 'task.claimed']) {
    if (!log.includes(want)) throw new Error(`事件日志中缺少 ${want}`);
  }
  if (!/devon\(dev\) question\.answered/.test(log) || !/pam\(product\) question\.confirmed/.test(log)) throw new Error('事件中的身份不对');
  console.log(sf('log', 'verify').trim());
  console.log('✅ Web 控制台端到端测试通过');
}

main()
  .catch((e) => {
    console.error('❌', e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const p of procs) p.kill();
    setTimeout(() => rmSync(work, { recursive: true, force: true }), 300);
  });
