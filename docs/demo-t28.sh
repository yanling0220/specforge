# T2.8 实测：搭建示例项目到 spec 阶段（含 proposal 与一个已确认问题），之后由生成类 agent 接手
set -e
SRC="$(cd "$(dirname "$0")" && pwd)/demo-src"
sf() { node /Users/yan/Downloads/project/sdd_plantform/apps/cli/src/main.ts "$@"; }
D=/tmp/sf-t28; rm -rf $D; mkdir -p $D/src $D/test; cd $D
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
cat > openspec/changes/bulk-import/proposal.md <<'MD'
# 管理员批量导入用户

## Why
运营需要一次性导入几百个用户，目前只能逐个创建。

## What Changes
- 管理员上传 CSV（表头 email,name），系统逐行创建用户
- 返回成功数量和失败行（行号 + 原因），部分失败不影响其他行

## 范围外
- 不做 UI；不做导出；不修改已有用户
MD
sf restate bulk-import --text "管理员上传 CSV 批量创建 member 用户，返回成功数与带行号的失败原因" >/dev/null
sf restate bulk-import --confirm >/dev/null
sf q add bulk-import --q "CSV 中出现 role 列时是否按该列设置角色？" --severity blocking --category 业务规则 --option "A=忽略，一律 member" --option "B=按 role 列设置" >/dev/null
sf q answer bulk-import Q-1 --text "忽略 role 列，导入的用户一律为 member" --option A >/dev/null
sf q confirm bulk-import Q-1 --on-behalf lily:product --via "产品评审会 2026-11-13" >/dev/null
for d in $(node -e "console.log(JSON.parse(require('fs').readFileSync('.specforge/config.json')).dimensions.join(' '))"); do sf dim set bulk-import "$d" covered >/dev/null; done
git add -A; git commit -qm "proposal"
sf advance bulk-import
sf status bulk-import | head -3
