# SpecForge（暂定名）

AI 研发流程平台：把 AI 的开发工作纳入 **需求分析 → 规格 → 实现 → 收尾验证** 的流水线，
由引擎强制执行门禁、亲自采集证据、全程哈希链留痕。设计见 [docs/design.md](docs/design.md)，进度与任务见 [docs/TASKS.md](docs/TASKS.md)（AI 工具接手请先读 [AGENTS.md](AGENTS.md)）。

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

# 技术方案 openspec/changes/<id>/design.md：正文引用每个 AC；
#   「## 结构变更」逐条 - [S-n] …（无变更写 - 无：<原因>）
sf design approve add-bulk-import        # 仅 L 档或涉及受保护路径时需要
sf advance add-bulk-import               # design → tasks

# 任务 openspec/changes/<id>/tasks.md：- [ ] T-1 标题（AC-1, S-1）依赖 T-0
sf advance add-bulk-import               # tasks → implement（勾选进度不影响 G4）
sf agent implement add-bulk-import       # 逐个实现任务：独立 worktree，越界改动整体丢弃，引擎提交并合入

# 实现 → 收尾双子门禁
sf advance add-bulk-import               # implement → closing
sf verify add-bulk-import                # 引擎在干净 worktree 中重跑验证
sf agent review add-bulk-import          # 独立审查 agent（也可手动：sf review --kind agent …）
sf review add-bulk-import --kind human --verdict pass
sf advance add-bulk-import               # closing → delivered（需要 G6）

sf log verify                            # 校验哈希链与带外修改
```

## AI agent

四种后端，按角色在 `.specforge/config.json` 中配置，或用命令行 `--backend` 临时指定：

| backend | 接入方式 | 只读约束 | 需要 |
|---|---|---|---|
| `claude`（默认） | Claude Agent SDK | 内置工具白名单 + canUseTool 拦截 | Claude 凭据 |
| `deepseek` | DeepSeek 的 Anthropic 兼容接口，跑在 Claude Agent SDK 上 | 同上 | `DEEPSEEK_API_KEY` |
| `codex` | OpenAI Codex SDK，只读沙箱 + 结构化输出整批提交 | `read-only` 沙箱，禁网 | Codex 登录或 key |
| `openai-compatible` | 引擎自带的 agent 循环，任意 OpenAI 兼容接口（预设 `deepseek`、`ollama`） | 只提供引擎实现的只读工具 | 视服务而定 |

```json
"agents": {
  "default": { "backend": "deepseek" },
  "roles": {
    "reviewer": { "backend": "codex", "effort": "high" },
    "analyst":  { "backend": "openai-compatible", "provider": "deepseek", "model": "deepseek-v4-pro" }
  }
}
```

```bash
export DEEPSEEK_API_KEY=...
sf agent analyze <id> --backend deepseek
sf agent review  <id> --backend openai-compatible --provider deepseek
```

- 配置里只写环境变量名（`apiKeyEnv`），不写 key 本身。
- 无论哪个后端：agent 只能通过平台工具提交，由引擎校验后写入；只读角色运行前后工作区必须一致，否则产出作废；每次运行都写 `agent.run` 事件。
- `--budget` 只对 claude / deepseek 生效；兼容接口的费用以 token 数报告。
