set -e
SRC="$(cd "$(dirname "$0")" && pwd)/demo-src"
sf() { node /Users/yan/Downloads/project/sdd_plantform/apps/cli/src/main.ts "$@"; }
D=/tmp/sf-t26v; rm -rf $D; mkdir -p $D/src $D/test; cd $D
git init -q; git config user.email t@t; git config user.name t
echo '{ "name": "user-admin", "type": "module", "scripts": { "test": "node --test" } }' > package.json
cp "$SRC"/*.js src/
cat > test/users.test.js <<'JS'
import { test } from 'node:test';
import assert from 'node:assert';
import { createUser } from '../src/users.js';
test('创建用户', () => assert.equal(createUser({ email: 'a@b.c', name: 'A' }).role, 'member'));
JS
git add -A; git commit -qm init
sf init >/dev/null
node -e "const fs=require('fs'),f='.specforge/config.json',c=JSON.parse(fs.readFileSync(f));c.verify=[{name:'test',command:'node --test'}];c.agents={default:{backend:'deepseek'}};c.tdd={command:'node --test {files}'};fs.writeFileSync(f,JSON.stringify(c,null,2))"
git add -A; git commit -qm "specforge init"
sf whoami --set yan:dev >/dev/null
sf change new bulk-import --title "管理员批量导入用户" --tier M >/dev/null
sf restate bulk-import --text "管理员上传 CSV 批量创建 member 用户，返回成功数与带行号的失败原因" >/dev/null
sf restate bulk-import --confirm >/dev/null
for d in $(node -e "console.log(JSON.parse(require('fs').readFileSync('.specforge/config.json')).dimensions.join(' '))"); do sf dim set bulk-import "$d" covered >/dev/null; done
sf advance bulk-import
C=openspec/changes/bulk-import; mkdir -p $C/specs/user-import
cat > $C/specs/user-import/spec.md <<'MD'
## ADDED Requirements

### Requirement: CSV 导入
系统 SHALL 提供 `importUsers(operator, csv)`：csv 为含表头 `email,name` 的文本，每个数据行调用现有 createUser 创建用户，角色一律为 member（忽略 CSV 中的任何 role 列）。

#### Scenario: [AC-1] 导入合法文件
- **WHEN** 管理员导入包含 2 个合法行的 CSV
- **THEN** 返回 `{ success: 2, failed: [] }`，两个用户角色均为 member

#### Scenario: [AC-2] 部分失败
- **WHEN** 第 2 行邮箱格式错误、第 3 行邮箱已存在
- **THEN** 其余行照常创建；failed 为 `[{ line: 2, reason: '邮箱格式错误' }, { line: 3, reason: '邮箱已存在' }]`（line 为 CSV 文件行号，表头为第 1 行）

### Requirement: 权限
系统 SHALL 只允许管理员导入。

#### Scenario: [AC-3] 非管理员导入
- **WHEN** role 为 member 的用户调用 importUsers
- **THEN** 抛出“需要管理员权限”，不创建任何用户
MD
sf spec approve bulk-import >/dev/null; sf advance bulk-import
cat > $C/design.md <<'MD'
# 方案

新增 `src/import.js`，导出 `importUsers(operator, csv)`：
- 入口调用 `requireAdmin(operator)`（AC-3）。
- 按行拆分，跳过表头与空行；每行按逗号拆分取 email、name，调用 `createUser({ email, name, role: 'member' })`（AC-1）。
- createUser 抛出的错误记录为 `{ line, reason: e.message }`，继续处理后续行（AC-2）。

## 结构变更
- [S-1] 新增模块 `src/import.js`
- [S-2] 新增测试 `test/import.test.js`
MD
sf advance bulk-import
cat > $C/tasks.md <<'MD'
- [ ] T-1 实现 importUsers 并补充测试（AC-1, AC-2, S-1, S-2）
- [ ] T-2 加入管理员权限校验并补充测试（AC-3）依赖 T-1
MD
git add -A; git commit -qm "规格、方案与任务"
sf advance bulk-import
sf status bulk-import | head -9
