# AGENTS.md — 给接手本项目的 AI 工具

本项目（SpecForge）会由不同的 AI 工具/模型轮流开发。**进度只记录在仓库里**，不要依赖任何聊天记录。

## 开工前（每次都做）

1. 读 [docs/TASKS.md](docs/TASKS.md)：当前快照、任务状态、已知问题、实测记录。
2. 需要背景时读 [docs/design.md](docs/design.md)（设计原则、门禁定义、数据模型）。
3. 验证当前状态是好的：

   ```bash
   npm install
   npm run typecheck   # 必须无错误
   npm test            # 必须全部通过；数量应与 TASKS.md 快照一致
   git log --oneline -5
   ```

   如果和 TASKS.md 记录的不一致（测试失败、数量对不上、有未记录的提交），**先查明原因并在 TASKS.md 中记录**，再开始新任务。

## 选任务

- 优先做状态为 `verify` 的任务（代码已写完、待确认）。
- 然后按顺序选第一个依赖全部 `done` 的 `todo` 任务。
- 用户指定了任务时以用户为准。
- 开始时把状态改为 `doing`，注明日期和工具/模型。

## 完成一个任务

1. 代码 + 测试。纯逻辑放 `packages/core`（纯函数、不做 IO），git/进程放 `packages/runner`，模型相关放 `packages/agents`，命令放 `apps/cli`。
2. `npm run typecheck && npm test` 全部通过。
3. 更新 docs/TASKS.md：状态改为 `done`（需要真实模型或人工确认的改为 `verify`）、填验收证据、更新"当前快照"的测试数和"下一个建议任务"、在"变更日志"追加一行。
4. 有设计变化时同步更新 docs/design.md。
5. 一个任务一个提交，提交信息写明任务 ID，例如 `T2.4：G3 方案门`。

## 不可违反的规则

- **AI 不能推进流程**：状态机只在引擎里；agent 只能通过平台工具提交草稿，由引擎校验后写入。不要给 agent 加"直接改状态"的能力。
- **所有状态修改走 `Store.mutate`**，以便写入哈希链。不要直接写 `.specforge/changes/*` 下的文件。
- **证据由引擎采集**，不采信 agent 的自述。
- **默认未验证**：门禁没有检查项或任一项失败都不算通过。
- 不要提交密钥。API key 只通过环境变量提供，配置里只写变量名（`apiKeyEnv`）。
- 调用真实模型会产生费用：除非用户同意，测试一律用 `ScriptedAdapter` 或注入的假客户端。

## 环境备注

- Node ≥ 22.18，直接运行 TypeScript，无构建步骤。CLI：`node apps/cli/src/main.ts`。
- DeepSeek：`DEEPSEEK_API_KEY`（用户已写入 `~/.zshrc`）。
- 远程仓库：`git@github.com:yanling0220/specforge.git`；本仓库的提交邮箱已设为 GitHub noreply 地址，不要改成真实邮箱（GitHub 会拒绝推送）。
