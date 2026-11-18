// 本地验收准备：不启动服务、不调用模型、不发送消息、不自动登记审查通过。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAll, Store, verifyLog } from '@specforge/store';

assert.equal(process.argv.length, 2, '本脚本不接受目标路径；每次创建独立临时目录，不修改已有项目');
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'sf-im-acceptance-'));
chmodSync(work, 0o700);
const root = join(work, 'project');
mkdirSync(join(root, 'src'), { recursive: true });
mkdirSync(join(root, 'test'));
const cli = join(source, 'apps/cli/src/main.ts');
const run = (command, args) => execFileSync(command, args, {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
const git = (...args) => run('git', args).trim();
const sf = (...args) => run(process.execPath, [cli, ...args]);
const write = (path, text) => writeFileSync(join(root, path), text);
const privateJson = (path, value) => writeFileSync(join(work, path), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const dev = 'acceptance-dev:dev';

try {
  git('init', '-q');
  git('config', 'user.name', 'SpecForge acceptance');
  git('config', 'user.email', 'acceptance@example.invalid');
  write('package.json', JSON.stringify({ name: 'specforge-im-acceptance', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  write('.gitignore', '.specforge/*\n!.specforge/config.json\n');
  copyFileSync(join(source, 'docs/demo-src/users.js'), join(root, 'src/users.js'));
  write('test/users.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser, listUsers, MAX_NAME } from '../src/users.js';

test('创建默认 member 用户，保留姓名、邮箱和创建时间', () => {
  const before = Date.now();
  const user = createUser({ email: 'member@example.invalid', name: 'Member' });
  assert.equal(user.role, 'member');
  assert.equal(user.name, 'Member');
  assert.equal(user.email, 'member@example.invalid');
  assert.ok(user.createdAt >= before && user.createdAt <= Date.now());
});
test('允许显式 admin 角色', () => {
  assert.equal(createUser({ email: 'admin@example.invalid', name: 'Admin', role: 'admin' }).role, 'admin');
});
test('拒绝空邮箱和不含 @ 的邮箱', () => {
  for (const email of ['', 'invalid']) assert.throws(() => createUser({ email, name: 'Member' }), /邮箱格式错误/);
});
test('拒绝重复邮箱', () => {
  createUser({ email: 'duplicate@example.invalid', name: 'First' });
  assert.throws(() => createUser({ email: 'duplicate@example.invalid', name: 'Second' }), /邮箱已存在/);
});
test('姓名不能为空或超过上限，允许恰好达到上限', () => {
  assert.throws(() => createUser({ email: 'empty@example.invalid', name: '' }), /姓名/);
  assert.throws(() => createUser({ email: 'long@example.invalid', name: 'x'.repeat(MAX_NAME + 1) }), /姓名/);
  assert.equal(createUser({ email: 'limit@example.invalid', name: 'x'.repeat(MAX_NAME) }).name.length, MAX_NAME);
});
test('拒绝其他角色', () => {
  assert.throws(() => createUser({ email: 'role@example.invalid', name: 'Member', role: 'owner' }), /角色无效/);
});
test('列表包含此前成功创建的用户，不包含校验失败的记录', () => {
  const emails = listUsers().map(user => user.email).sort();
  assert.deepEqual(emails, ['admin@example.invalid', 'duplicate@example.invalid', 'limit@example.invalid', 'member@example.invalid']);
});
`);
  git('add', '.');
  git('commit', '-qm', 'Existing user demo and seven executable checks');
  sf('init');
  const configFile = join(root, '.specforge/config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.verify = [{ name: 'test', command: 'node --test' }];
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  git('add', '.gitignore', '.specforge/config.json');
  git('commit', '-qm', 'Configure dependency-free engine verification');

  const tokens = {};
  for (const [name, role, extra] of [
    ['acceptance-dev', 'dev', ['--admin']],
    ['acceptance-product', 'product', []],
  ]) {
    const result = sf('user', 'add', name, '--role', role, ...extra, '--as', dev);
    const token = result.match(/sf_[A-Za-z0-9_-]{43}/)?.[0];
    assert.ok(token, '登录令牌未生成');
    tokens[name] = { role, token };
    privateJson('login-tokens.local.json', tokens);
  }
  console.log('已创建隔离仓库和两个演示账号；令牌仅保存在本机权限为 0600 的文件中。');

  sf('change', 'new', 'confirm-answer', '--title', 'IM 验收：已有答案待产品确认', '--tier', 'S', '--as', dev);
  sf('q', 'add', 'confirm-answer', '--q', '本次专用群验收是否仅包含两类最小提醒？', '--severity', 'minor', '--category', '业务规则', '--as', dev);
  sf('q', 'answer', 'confirm-answer', 'Q-1', '--text', '仅包含已有答案待确认和就绪后待开发者签字，消息不包含业务正文。', '--as', dev);
  sf('change', 'new', 'ready-signoff', '--title', 'IM 验收：已有示例就绪待签字', '--tier', 'S', '--as', dev);
  sf('restate', 'ready-signoff', '--text', '核对已有内存用户示例：默认 member、显式 admin、邮箱非空且含 @、邮箱不重复、姓名为 1～32 字、拒绝其他角色，列表仅包含成功创建的用户。', '--as', dev);
  sf('restate', 'ready-signoff', '--confirm', '--as', dev);
  write('openspec/changes/ready-signoff/proposal.md', `# IM 验收：已有示例就绪待签字

## Why
复用 SpecForge docs/demo-src/users.js 的已有内存用户示例，为通知验收提供可实际验证、可复核的独立项目。

## What Changes
保留既有实现；七项 node:test 核对默认 member、显式 admin、非空且含 @ 的邮箱、重复邮箱拒绝、1～32 字姓名、其他角色拒绝，以及列表包含成功创建的用户。

## 范围
这是隔离演示项目，账号是演示身份。真实成员仍需在授权后绑定自己的群 Open ID 并使用对应账号登录。
`);
  git('add', 'openspec');
  git('commit', '-qm', 'Describe the two isolated notification acceptance items');
  sf('advance', 'ready-signoff', '--as', dev);
  sf('advance', 'ready-signoff', '--as', dev);
  privateJson('verification-output.local.json', { output: sf('verify', 'ready-signoff', '--as', dev) });
  const store = new Store(root);
  const state = store.load('ready-signoff');
  const gates = evaluateAll(store, state);
  assert.equal(state.change.stage, 'closing');
  assert.equal(gates.G1.status, 'passed');
  assert.equal(gates.G6A.status, 'passed', 'sf verify 退出 0 不代表门禁通过，必须核对引擎评估');
  assert.equal(state.reviews.length, 0);
  assert.equal(verifyLog(store).ok, true);
  console.log('已由引擎推进到 closing，并在干净 worktree 中实际执行当前与基线验证。');

  const settings = JSON.parse(readFileSync(join(source, 'docs/examples/notifications.acceptance.json'), 'utf8'));
  assert.equal(settings.projects[0].enabled, false);
  privateJson('notifications.local.json', settings);
  const options = ['--notifications', join(work, 'notifications.local.json'), '--project', 'im-acceptance'];
  const events = store.events();
  const preview = JSON.parse(sf('notify', 'preview', ...options));
  const status = JSON.parse(sf('notify', 'status', ...options));
  assert.equal(preview.enabled, false);
  assert.equal(preview.pendingCount, 1, '未审查时只有问题提醒；不得伪造签字就绪');
  assert.equal(preview.candidates[0].kind, 'question-confirmation');
  assert.equal(status.count, 0);
  assert.deepEqual(store.events(), events);
  privateJson('preview.local.json', preview);
  privateJson('status.local.json', status);
  privateJson('gates.local.json', { output: sf('status', 'ready-signoff') });
  privateJson('log-verification.local.json', { output: sf('log', 'verify') });
  console.log(JSON.stringify({
    work, root, projectId: 'im-acceptance', head: git('rev-parse', 'HEAD'),
    accounts: Object.keys(tokens), notificationConfig: join(work, 'notifications.local.json'),
    tokensFile: join(work, 'login-tokens.local.json'),
    pendingCount: preview.pendingCount, sent: 0,
    next: '独立核对提交中的示例与七项测试，使用现有审查入口记录实际报告后再预览两项待办；真实投递仍需目标配置与授权。',
  }, null, 2));
} catch {
  // 子进程输出可能包含刚生成的登录令牌，失败时只报告保留目录，不转储输出。
  console.error('准备失败，现场保留在 ' + work + '；未启动通知服务。请本机核对后重新运行以创建新的独立项目。');
  process.exitCode = 1;
}
