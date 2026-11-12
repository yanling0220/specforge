# SpecForge（暂定名）

AI 研发流程平台：把 AI 的开发工作纳入 **需求分析 → 规格 → 实现 → 收尾验证** 的流水线，
由引擎强制执行门禁、亲自采集证据、全程哈希链留痕。设计见 [docs/design.md](docs/design.md)。

当前是**第一期**：`core`（门禁 / 问题节点 / 哈希链）+ `runner`（worktree 验证）+ `cli`。

## 运行

需要 Node ≥ 22.18（直接运行 TypeScript，无需构建）。

```bash
npm install
npm test            # 单元 + 集成测试
npm run typecheck
alias sf="node $(pwd)/apps/cli/src/main.ts"
sf --help
```

## 在项目中使用

```bash
cd <你的 git 项目>
sf init                                  # 生成 .specforge/config.json，按项目修改 verify 步骤
sf whoami --set <名字>:dev
sf change new add-bulk-import --title "批量导入用户" --tier M

# 需求分析与问题节点
sf restate add-bulk-import --text "…" && sf restate add-bulk-import --confirm
sf q add add-bulk-import --q "超限文件怎么处理？" --severity blocking --category 业务规则 \
  --option "A=直接拒绝|改动小" --option "B=分片上传|+2 天" --recommend A
sf q answer  add-bulk-import Q-1 --text "直接拒绝" --option A
sf q confirm add-bulk-import Q-1 --on-behalf "王五:product" --via "<会议纪要链接>"
sf status add-bulk-import && sf advance add-bulk-import

# 规格（OpenSpec 格式，Scenario 标题带 [AC-n]）
#   openspec/changes/add-bulk-import/specs/<capability>/spec.md
sf spec approve add-bulk-import && sf advance add-bulk-import

# 实现 → 收尾双子门禁
sf advance add-bulk-import               # implement → closing
sf verify add-bulk-import                # 引擎在干净 worktree 中重跑验证
sf review add-bulk-import --kind agent --verdict pass --coverage AC-1
sf review add-bulk-import --kind human --verdict pass
sf advance add-bulk-import               # closing → delivered（需要 G6）

sf log verify                            # 校验哈希链与带外修改
```
