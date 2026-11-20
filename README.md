# SpecForge（暂定名）

AI 研发流程平台：把 AI 的开发工作纳入 **需求分析 → 规格 → 实现 → 收尾验证** 的流水线，
由引擎强制执行门禁、亲自采集证据、全程哈希链留痕。设计见 [docs/design.md](docs/design.md)，进度与任务见 [docs/TASKS.md](docs/TASKS.md)（AI 工具接手请先读 [AGENTS.md](AGENTS.md)）。

当前进度：门禁、CLI、多个 agent 后端、Web 人工操作、身份登录、多项目与 Postgres 索引已交付。
审批收件箱已交付；IM 通知实现已交付，真实飞书群验收按用户要求暂缓。详细状态见 [任务清单](docs/TASKS.md)。

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

## 产品方本人确认

管理员在已初始化的项目中启用用户名册，并为产品方创建账号（命令会显示该用户的登录令牌）：

```bash
sf user add devon --role dev --admin
sf user add pam --role product --as devon:dev
```

启动 Web 控制台后，将用户名、登录令牌和问题链接交给产品方。
问题链接格式为 `#/changes/<id>/analysis/<Q-n>`；未登录时先显示登录页，登录后仍停留在该问题。
产品方核对当前答案后点「以 product 身份确认」，记录中的确认人就是本人，无需开发者代录。
链接中不携带登录令牌，打开链接本身不会确认答案。
其他人修订答案时，旧操作表单会关闭；需要核对新版本后重新确认。

## 审批收件箱（T4.6）

登录后点击顶栏「审批收件箱」（`#/inbox`），查看当前项目、当前角色需要处理的答案确认、规格 / 方案审批和开发者签字。多角色账号通过顶栏切换角色，可按事项类型筛选或手动刷新；业务变更自动刷新，每 15 秒补查 HEAD 或文件变动。

点击「查看并处理」进入现有问题或门禁详情，核对最新内容后确认、审批、签字或打回。列表只显示已经就绪的审批 / 签字；同角色任一成员处理后，该项自动移除。读取失败会展示错误。收件箱不需要 IM 配置，查看和筛选不写业务状态；没有待审批不等于整个项目已经完成。首版按项目分别查看，任务接管仍在任务面板。

## 多项目服务（T4.3b～e）

管理员先在每个独立 Git 仓库中执行 `sf init` 并启用用户名册，再编写服务端项目登记文件，例如 `/srv/specforge/projects.json`：

```json
{
  "version": 1,
  "projects": [
    { "id": "alpha", "root": "/srv/projects/alpha" },
    { "id": "beta", "root": "/srv/projects/beta" }
  ]
}
```

```bash
npm run web:build
node /opt/specforge/apps/server/src/main.ts --projects /srv/specforge/projects.json --port 4317
```

可从任意目录启动；相对 `root` 按登记文件所在目录解析。ID 为 1–64 位小写字母、数字、下划线或短横线，首位需为字母或数字。重复真实仓库、共享 Git 元数据的 worktree，以及 `.specforge/` 或 `openspec/` 中的符号链接会被拒绝。

各项目独立登录：`POST /p/alpha/api/auth/login`，JSON 正文为 `{ "name": "用户名", "token": "登录令牌" }`；会话 Cookie 的名称与路径按项目隔离。令牌不写入登记文件或 URL。读接口使用 `/p/alpha/api/...`，订阅使用 `/p/alpha/ws?changeId=<id>&after=<seq>`；B 的接口对应 `/p/beta/...`，需另行登录。

浏览器打开 `http://127.0.0.1:4317/`，输入管理员提供的项目 ID；也可直接访问 `/p/alpha/#/changes/<变更ID>/analysis/<Q-n>`。登录后保留原问题链接，本人确认只绑定当前答案版本。每个项目分别登录，同名账号也不共用会话。

顶栏「切换项目」返回入口。本标签页访问记录只列出已访问且重新核对权限后仍可用的项目，并保留各项目最后的页面链接。切换会重新加载页面并核对登录。回到原项目和角色时，可在原会话内继续编辑该标签页已保存的答案草稿。

后台查询、订阅与既有业务写接口均按项目隔离，写操作仍要求有效会话及对应角色。默认每个项目使用独立内存 SQLite 索引，不能同时传 `--db`。可用 `--index <JSON>` 显式选择 Postgres：配置只保存 `connectionStringEnv` 环境变量名，多项目使用登记 ID，单项目需另设稳定 `projectId`。PostgreSQL 17.4 的真实契约、故障、迁移回退和多项目浏览器验收已通过；配置、schema v1、迁移 / 回退、独立实库测试命令及故障边界见 [索引说明](docs/index-backends.md)。未配置时不连接数据库。

全局 `/api/health` 只报告服务模式，不提供项目列表；鉴权后的项目 `/api/index` 返回索引状态和最后成功同步序号。索引失败返回 503，不展示陈旧列表或自动回退；成功的业务写入不会自动重放。不可用项目返回通用 `503 project_unavailable`，健康项目继续服务；启动时不可用的项目需修复后重启，运行中修复可恢复访问，已关闭的订阅需重连。未知或不可用的项目入口仍提供通用外壳与切换链接，不回退读取其他项目。

浏览器验收：先 `npm run web:build`，再运行 `npm run web:e2e:projects`（需要本机 Chrome，可用 `CHROME` 指定路径）；既有单项目回归仍为 `npm run web:e2e`。两者都只创建临时项目，不调用模型。

登录后打开「工作台」，可按角色查看待回答、待修订、待确认和等待其他角色的问题。问题详情展示当前答案、退回意见、选项和历史。标准选项自动生成可预览的正文。版本变化后保留草稿，核对最新状态后再继续。规格、方案和签字位于「其他审批」。

变更详情的「代码审查」标签在实现、收尾和交付阶段显示基线与当前 HEAD 的差异。选中文件后加载统一 diff。当前与历史报告、AC 引用和验证证据均可从这里查看。签字请从「查看门禁 / 签字」进入门禁页，签字记录绑定操作时的 HEAD。

审查链接为 `#/changes/<变更ID>/review`，多项目部署下放在对应的 `/p/<项目ID>/` 页面，沿用当前部署前缀。构建 Web 后可用 `npm run web:e2e:review` 在本机 Chrome 复跑根路径单项目和带前缀双项目验收。[验收记录](docs/t4.7-plan.md#47d-evidence)

省略 `--projects` 仍使用原单项目 CLI / Web 模式。自动日志锚定按各仓库原有配置运行；非本机访问仍需 HTTPS 反向代理。

CLI、HTTP 与 Store 共用仓库级跨进程锁，覆盖复合操作和长任务；读请求也参与，忙时立即返回 `409 write_busy`，不同仓库不互相阻塞。Web 将同文档请求串行发送，只读请求对明确的忙错误有限重试；业务提交不会自动重放。中断不会自动抢锁或补成功事件，需用 `sf lock status` / `sf lock recover --reason` 核对；部分文件写入不能称为事务回滚。操作、恢复和本地文件系统限制见 [写入恢复说明](docs/write-recovery.md)。

## 飞书群通知（T4.5d）

服务端可通过 `--notifications <JSON>` 配置逐项目飞书专用群机器人，默认关闭，只提醒已有答案待角色确认、收尾就绪后待开发者签字。配置只保存凭据环境变量名，成员显式映射为 Open ID；发送在仓库写锁外执行，结果和去重账本保存在哈希链中。

适配器、后台 worker、只读管理入口、管理员显式重试和部署前缀已通过注入传输、真实进程中断及 Chrome 回归验收，尚未向真实群发送。配置、结果语义、关闭、通知 owner 恢复、`sf notify preview / status / retry` 和前缀部署说明见 [通知说明](docs/im-notifications.md)。T4.5e 的[真实验收步骤与证据表](docs/t4.5-acceptance.md)、[关闭配置模板](docs/examples/notifications.acceptance.json)、[本地准备脚本](docs/prepare-im-acceptance.mjs)已交付；2026-11-18 用户要求暂缓真实验收，已列待办。选择恢复后可从隔离项目开始，补真实群配置、核对实际预览并授权后投递。

## 日志锚定

`sf log anchor`（dev）将当前事件序号和链头哈希保存到独立的 `specforge-audit` Git 分支。
它不切换分支、不改 HEAD、暂存区或工作区；链头未变时不重复提交。
`sf log verify` 和 `GET /api/log/verify` 会检查所有历史锚定，发现整链重算或截断后拒绝创建新锚定。
尚无锚定时，CLI 明确提示「尚未锚定」，接口的 `anchors.status` 为 `unverified`。

在 `.specforge/config.json` 加上 `"audit": { "anchorIntervalMs": 60000 }`，server 启动时和每分钟会自动锚定有变化的日志。
间隔至少 1000 毫秒；不配置时关闭自动锚定。失败会报告错误并保留原锚定，server 关闭时停止定时器。

防止本地日志和审计分支一起被重写，需要把审计分支或可信 commit SHA 保存在独立的可信位置。
经确认后可手工执行 `git push origin specforge-audit`，并在远端保护该分支、禁止强推和删除；平台不会自动推送。
从可信副本取回完整审计历史后，用 `sf log verify --anchor <完整审计 commit SHA>` 校验，即使本地审计分支已删除或重建仍能检测旧记录冲突。
首次锚定不能证明此前日志没有被重写；最后一次锚定之后的尾部事件需要下一次锚定。

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
