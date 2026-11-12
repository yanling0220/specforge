# SpecForge（暂定名）

AI 研发流程平台：把 AI 的开发工作纳入 **需求分析 → 规格 → 实现 → 收尾验证** 的流水线，
由引擎强制执行门禁、亲自采集证据、全程哈希链留痕。设计见 [docs/design.md](docs/design.md)。

当前进度：第一期完成（`core` 门禁 / 问题节点 / 哈希链，`runner` worktree 验证，`cli`）；
第二期进行中，`agents` 已接入 Claude Agent SDK（需求分析 agent、独立审查 agent）。

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

# 需求分析与问题节点（先在 openspec/changes/<id>/proposal.md 写需求）
sf agent analyze add-bulk-import --budget 2   # AI 生成复述、分解树、假设、维度结论、问题节点
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
sf agent review add-bulk-import          # 独立审查 agent（也可手动：sf review --kind agent …）
sf review add-bulk-import --kind human --verdict pass
sf advance add-bulk-import               # closing → delivered（需要 G6）

sf log verify                            # 校验哈希链与带外修改
```

## AI agent

- 认证沿用 Claude Code / Agent SDK 的方式（`ANTHROPIC_API_KEY`，或已登录的 Claude Code）。
- 默认模型 `claude-opus-5-5`，可在 `.specforge/config.json` 中按角色配置：

```json
"agents": {
  "default": { "backend": "claude", "model": "claude-opus-5-5", "maxBudgetUsd": 2 },
  "roles": { "reviewer": { "backend": "claude", "effort": "xhigh" } }
}
```

- agent 只能通过平台工具提交结果，由引擎校验后写入；只读角色运行前后工作区必须一致，否则产出作废。
- Codex、DeepSeek 后端尚未接入（配置后会提示）。
