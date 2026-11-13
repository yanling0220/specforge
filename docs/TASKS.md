# 任务清单与状态

> 这是项目的**唯一进度来源**。任何 AI 工具或开发者接手时，先读 [AGENTS.md](../AGENTS.md) 的交接规则，再读本文件。
> 设计依据见 [design.md](design.md)。

状态：`done` 已完成并验证 · `doing` 进行中 · `todo` 待开始 · `blocked` 被阻塞 · `verify` 代码已完成、待实测确认

最后更新：2026-11-13 · Claude Code（Opus 5.5） · T2.6v、T2.7、T2.10、T2.9、T2.11、T3.6、T2.8、T3.1、T3.2、T3.3、T4.1、T3.4、T3.5 完成

---

## 当前快照

- 测试：194 个全部通过；浏览器端到端 `npm run web:e2e` 通过（`npm test`），类型检查无错误（`npm run typecheck`，含 `apps/web`）
- 已推送：https://github.com/yanling0220/specforge （`main`）
- **下一个建议任务：`T4.4`**（哈希链头定期锚定，防止整条链被重写）；`T4.2`（产品方直接登录确认）已基本被 T4.1 + T3.4 覆盖，可复核后关闭；`T2.3c` 需要 Codex 登录。Web 控制台需先 `npm run web:build`，再在项目目录运行 server。注意：已有项目需配置 `tdd.command`；首次 `sf verify` 会额外验证一次基线 commit

---

## 第一期：门禁引擎与 CLI（已完成）

| ID | 任务 | 状态 | 验收 / 证据 |
|---|---|---|---|
| T1.1 | 共享类型、项目配置（宪法） | done | `packages/shared` |
| T1.2 | 问题节点生命周期：起草、双方确认、代录必须写渠道、驳回、修订不可删改 | done | `packages/core/test/questions.test.ts` |
| T1.3 | G1 理解门 / G2 规格门 / G6 双子门禁，状态机，内容哈希绑定与失效 | done | `packages/core/test/gates.test.ts` |
| T1.4 | 哈希链事件日志、带外修改检测 | done | `events-policy.test.ts`；`sf log verify` |
| T1.5 | runner：干净 worktree 验证、AC 覆盖、防作弊扫描（skip 标记、受保护路径） | done | `packages/runner/test/verify.test.ts` |
| T1.6 | CLI `sf`：init / change / q / restate / assume / dim / spec / verify / review / advance / log | done | 提交 `360ead2`；端到端演示见下方"实测记录" |

## 第二期：AI agent 与完整流水线

| ID | 任务 | 状态 | 依赖 | 验收标准 |
|---|---|---|---|---|
| T2.1 | agents 框架 + Claude 适配层（进程内 MCP 平台工具、canUseTool 白名单、运行前后工作区指纹校验、`agent.run` 事件） | done | T1.* | 提交 `b31d8a1`；`packages/agents/test/agents.test.ts` |
| T2.2 | 需求分析 agent、独立审查 agent（6B） | done | T2.1 | `sf agent analyze` / `sf agent review`；DeepSeek 实测通过 |
| T2.3 | 多后端：`deepseek`（Anthropic 兼容）、`openai-compatible`（自研循环，预设 deepseek/ollama）、`codex`（只读沙箱 + 整批提交） | done | T2.1 | 提交 `7154743`；`backends.test.ts` |
| T2.3v | 确认问题分类修复（`cd9ece1`）有效：在干净示例仓库上用 DeepSeek 跑分析 | done | T2.3 | 部分通过：核心业务问题（导入 admin、部分成功、重复邮箱、失败原因展示、交付形态）都要求 product；Q-7 行数上限、Q-8 是否做审计仍被归为 dev-only → 新增 `sf q require` 由人兜底追加确认角色（T2.3w）。见实测记录 |
| T2.3w | `sf q require <id> <Q> --role product --reason`：追加确认角色（只增不减、必须写原因、已确认答案回到待确认、写入哈希链） | done | T1.2 | `questions.test.ts`；在 T2.3v 的真实输出上实测 Q-8 |
| T2.3c | Codex 后端实测 | todo | T2.3 | 需要 Codex 登录；跑一次 `sf agent review --backend codex` 成功写入审查记录 |
| T2.4 | G3 方案门：解析 `design.md`；必须覆盖全部 AC、不得引用不存在的 AC；必须有「## 结构变更」清单（`- [S-n] …` 或 `- 无：<原因>`）；L 档或结构变更涉及受保护路径时需人工审批（绑定 design + spec 哈希） | done | T1.3 | `packages/core/test/design.test.ts`；状态机加入 `design` 阶段；`sf design approve`；审查 agent 读取结构变更清单判断计划外新增；CLI 端到端演示通过 |
| T2.5 | G4 任务门：解析 `tasks.md`（`- [ ] T-n 标题（AC-n, S-n）依赖 T-m`）；每个任务关联 AC；引用必须存在；每个 AC 与结构变更都有任务负责；依赖存在、无自依赖、无环；绑定任务结构而非原文（勾选进度不使 G4 失效） | done | T2.4 | `packages/core/test/tasks.test.ts`；状态机加入 `tasks` 阶段；`executionOrder` 供 T2.6 使用；CLI 端到端演示通过 |
| T2.6 | 可写的实现 agent `sf agent implement [--task T-n]`：独立 worktree；写文件执行时拦截（Claude canUseTool / openai-compatible 写工具）+ 引擎事后路径校验（`implementPolicy`：禁 openspec/、.specforge/、.git/、受保护路径）；主工作区指纹兜底；agent 自己的提交会被收拢；引擎勾选任务、提交（带 SpecForge-* trailer）、fast-forward 合入；`implement.committed / rejected / blocked` 事件 | done | T2.5 | `apps/cli/test/implement.test.ts`（8 个场景）、`packages/agents/test/implementer.test.ts` |
| T2.6v | 用真实模型跑 `sf agent implement`（DeepSeek，示例项目 `/tmp/sf-t26v`） | done | T2.6 | 全流程跑通：T-1 提交 `5d4f4d0`（测试 3/3），T-2 提交 `c57cbc3`（测试 4/4），均无越界；发现并修复符号链接路径误拦截。`sf advance` → `sf verify`（G6A 通过，AC-1~3 均有测试）→ `sf agent review`（pass）→ 开发者签字 → `delivered`；`sf log verify` 哈希链完整（30 条）。重建示例：`bash docs/demo-t26v.sh` |
| T2.7 | G5 TDD 门：引擎先确认新测试失败（RED），实现后通过（GREEN），绑定任务尝试与 commit | done | T2.6 | 配置 `tdd.command`（`{files}` 占位）+ 可选 `tdd.setup`；runner `runTdd`（base + 新测试 → RED，任务 commit → GREEN）；`sf agent implement` 合入前执行，不通过整体丢弃；手工任务用 `sf tdd`；G5 为 M/L 档 implement 出口门，要求证据 commit 仍在 HEAD 历史中。测试：`packages/core/test/tdd.test.ts`、`packages/runner/test/tdd.test.ts`、`apps/cli/test/implement.test.ts`（先红后绿、一开始就通过、没改测试、GREEN 失败、未配置、改写历史）；CLI 端到端（`/tmp/sf-t27`，手工实现 + `sf tdd` → G5 通过 → `implement → closing`）。局限见 design.md 4.3 |
| T2.8 | 生成类 agent：spec-writer（proposal→spec）、architect（→design）、planner（→tasks），只能写 `openspec/changes/<id>/**` | done | T2.4, T2.5 | `sf agent spec / design / plan`：agent 只读，产物经 `submit_*` 提交，引擎按 G2/G3/G4 规则（除人工审批外）自检，不通过退回 agent 修改；通过后引擎只写 `openspec/changes/<id>/`（`artifact.generated`），已有产物需 `--force`；可 `raise_question`。测试：`apps/cli/test/generate.test.ts`。DeepSeek 实测（`/tmp/sf-t28`，`bash docs/demo-t28.sh` 重建）：proposal → spec → design → tasks，G1–G4 全部通过，见实测记录 |
| T2.9 | 问题回流：所有阶段的 agent 都能 `raise_question`；新阻塞问题使 G1 失效并暂停相关任务 | done | T2.6 | 共享 `raise_question` 工具（实现、审查 agent）；问题新增 `taskIds`；`pausedTasks`（关联任务 + 传递依赖，无关联则全部）；实现 agent 提阻塞问题后改动丢弃、问题入库；`sf q add --tasks`；`sf status` 显示暂停任务。测试：`tasks.test.ts`（暂停规则）、`implement.test.ts`（提问后 G1 失效、advance 被拦截、任务暂停、无关任务继续、非阻塞照常提交、参数校验）、`engine.test.ts`（审查 agent 提问）；CLI 实测（`/tmp/sf-t29`） |
| T2.10 | spec 从 commit 读取，而不是工作区（目前 AC 列表读工作区、AC 覆盖读 commit，两者不一致） | done | — | `SourceTree`（工作区 / commit）；`readSpecFacts` / `readDesignFacts` / `readTasksFacts` 可按 SHA 读取；implement 及之后的阶段全部门禁按 HEAD 评估，`sf status` 提示未提交的 OpenSpec 改动；审查 agent 读被审 commit、实现 agent 读 base commit 中的材料。`apps/cli/test/engine.test.ts`；CLI 实测（`/tmp/sf-t27`） |
| T2.11 | 打回与修复轮次上限：审查 fail 自动回到实现，超过上限升级给人 | done | T2.6 | `workflow.maxFixRounds`（默认 3）；`packages/core/src/workflow.ts`（`applyReviewOutcome` / `resolveFixRound`）；`sf review` 与 `sf agent review` 共用 `recordReview`；修复模式的 `sf agent implement`；`sf status` 显示修复轮次与升级状态。测试：`workflow.test.ts`、`implement.test.ts`（打回 → 修复 → 升级全流程、修复暂停）；CLI 实测（`/tmp/sf-t27`：打回、未修复 advance 被拒、手工修复后回到收尾、再次不通过升级） |

## 第三期：服务与 Web 控制台

| ID | 任务 | 状态 | 依赖 | 验收标准 |
|---|---|---|---|---|
| T3.1 | server（Hono）：REST 读接口 + WebSocket 推送；SQLite 作为 `.specforge/` 的索引（文件为准） | done | T2.* 主体 | `apps/server`：只读 REST（change 列表 / 详情、实时门禁评估、问题、事件、链校验）+ WebSocket 推送（按 change 过滤、断线补发）；`node:sqlite` 内存索引，按事件序号增量同步，日志被改写时全量重建；默认只监听本机。`Store` 与门禁评估移到 `packages/store`，CLI 与 server 共用。测试：`apps/server/test/server.test.ts`（9 个）；实测 `/tmp/sf-t28` |
| T3.2 | Web 只读控制台（React + Vite）：看板、门禁面板（可点开证据）、事件时间线 | done | T3.1 | `apps/web`：看板（等人红点）、change 详情（阶段条、上游失效、提示条、门禁面板）、证据页（G5 RED/GREEN、验证步骤输出、哈希校验）、事件时间线（过滤），WebSocket 实时刷新；server 新增证据接口、托管构建产物（防目录穿越）、`/gates` 返回流水线。测试：`apps/web/test/model.test.ts`、`server.test.ts` 新增 4 个（含按 change 订阅时同批推送只收到自己的编号）。实测：`/tmp/sf-t27` 用 Chrome headless 截图核对看板、门禁、时间线、证据页 |
| T3.3 | 需求分析视图：分解树 + 问题卡片 + 完整核对历史 | done | T3.2 | 「需求分析」标签页：复述及确认状态、分解树（问题徽标、阻塞数累加）、问题卡片（选项、还缺的确认角色、关联与暂停的任务）、完整核对历史（含代录渠道、驳回、修改原因）、假设、维度；可深链接到问题。server 详情新增 `questionProgress` / `pausedTasks` / `restatementConfirmed`（core 规则计算）。测试：`model.test.ts` 新增 4 个、`server.test.ts` 新增 1 个。实测：`/tmp/sf-t33`（复制自 sf-t28，经 `Store.mutate` 补了分解树与假设）Chrome headless 截图核对 |
| T3.4 | 交互：回答/确认/驳回问题、审批 spec、签字、打回、接管 | done | T3.3 | 写操作抽到 `packages/store/src/actions.ts`，CLI 与 server 共用；server 写接口（问题 回答/确认/代录/驳回/推迟/作废、确认复述、假设、审批、签字/打回、推进），身份 = 登录用户 + 所选角色（名册校验），无名册不允许写，POST 只收 JSON；控制台按钮与表单、顶栏角色切换。测试：`apps/server/test/actions.test.ts`（8 个）；真实浏览器端到端 `apps/web/e2e/console.e2e.mjs`（连续 3 次通过）。接管（用户确认含义：任务由人接手实现，agent 不再处理）：`sf task list / claim / release`、控制台任务面板，`sf agent implement` 跳过被接管的任务；测试 `workflow.test.ts`、`implement.test.ts`、`actions.test.ts` 各新增 1–2 个，端到端加入接管步骤（3 次通过） |
| T3.5 | 产物审阅器：spec/design 行内评论，评论回传给 agent | done | T3.4, T2.8 | 行内评论（控制台「产物审阅」、`sf comment add / list / resolve / reopen`），按原文重新定位；未解决评论挡住 G2/G3/G4；有待处理评论时生成类 agent 进入修订模式，必须逐条回应，回应后为「已回应」、由人确认解决。测试：`core/test/comments.test.ts`、`generate.test.ts`（修订模式，ScriptedAdapter）、`actions.test.ts`、`model.test.ts`；浏览器端到端加入评论 → G2 被挡 → 确认解决（3 次通过）。DeepSeek 实测修订模式（`/tmp/sf-t35`）：3 条评论分别被修改 / 引用 Q-1 拒绝 / 先提问再引用 Q-4 拒绝，见实测记录；实测发现同文行误定位，已修复 |
| T3.6 | 测试数量不得下降（解析各语言测试报告） | done | — | `packages/core/src/testcount.ts`（node / vitest / jest / pytest / mocha / cargo + 自定义 `testReport.pattern`）；G6A 新增「测试数量没有下降」；`sf verify` 首次同时验证基线。测试：`testcount.test.ts`（各格式样例、判定规则）、`engine.test.ts`（真实 node --test：删测试不通过、补回通过）；CLI 实测（`/tmp/sf-t27`：基线 1 → 当前 4） |

## 第四期：团队化

| ID | 任务 | 状态 | 验收标准 |
|---|---|---|---|
| T4.1 | 身份与登录、角色权限（目前身份是自己声明的） | done | 用户名册 `.specforge/users.json`（`sf user add / list / set / token / disable`），修改写入哈希链，篡改即拒绝使用；CLI 身份（`whoami`、`--as`、`--on-behalf`）按名册校验角色；server 令牌登录（HttpOnly + SameSite=Strict 会话、12 小时过期、停用或重置令牌立即失效、失败 5 次锁定 10 分钟），启用名册后接口与 WebSocket 都需要登录，无名册时只能监听本机；Web 登录页与 401 自动回到登录。测试：`core/test/users.test.ts`、`cli/test/users.test.ts`、`server/test/auth.test.ts`。实测：`/tmp/sf-t33` 启用名册、角色与代录校验、curl 登录、登录页截图。依据见 design.md 9.3 |
| T4.2 | 产品方直接登录或通过链接确认问题（替代代录） | todo | |
| T4.3 | Postgres、多项目 | todo | |
| T4.4 | 哈希链头定期锚定（git 提交或服务端），防止整条链被重写 | todo | |
| T4.5 | IM 通知（待确认问题、待签字） | todo | |

---

## 已知问题

| 问题 | 影响 | 计划 |
|---|---|---|
| 未启用用户名册的项目仍是自行声明身份 | 兼容旧项目；server 此时只能监听本机 | 在项目中 `sf user add … --admin` 启用 |
| CLI 身份基于本地文件信任 | 名册只能防误用与冒名记录；有文件写权限的人仍可篡改，但会被 `sf log verify` 与名册校验发现 | T4.4（哈希链锚定）可进一步防整体改写 |
| server 不提供 HTTPS；会话只在内存中 | 非本机访问需放在 HTTPS 反向代理之后；server 重启后需重新登录 | — |
| 兼容接口（DeepSeek 等）不返回费用，`--budget` 不生效 | 只能看 token 数 | 可加按 token 的上限 |
| 实现 agent 的 Bash / run_command 能执行任意命令（如联网、写 worktree 外） | 写主工作区会被指纹检测拦截，但写其他目录无法发现 | 后续可接入沙箱（容器或 Claude SDK sandbox） |
| 升级给人后没有"解除升级"命令 | 人只能在 closing 阶段手工修复、重新验证和审查后交付；不能再让 agent 修复 | 需要时加 `sf escalation resolve` |
| 验证（6A）失败不自动打回 | 需要人判断后手工修复 | 视使用情况再定 |
| 生成类 agent 实测中，Q-2/Q-3 由 Claude 按推荐项代答、spec 由 Claude 以演示 dev 身份审批 | 仅限演示项目 `/tmp/sf-t28`，不代表真实产品决定 | — |
| server 启动时打印 `node:sqlite` 的 ExperimentalWarning | 仅提示，不影响功能 | Node 稳定后自然消失 |
| server 索引只在 `events.jsonl` 变化时同步 | 绕过引擎直接改状态文件不会触发推送；详情接口读文件，并会报告带外修改 | — |
| Web 控制台的实时刷新只在单元测试中验证了 WebSocket 推送 | 浏览器中「别人写入后自动刷新」没有端到端测试（自己写入后的刷新已覆盖） | 可扩展 `web:e2e` |
| G2 要求每个已确认问题都被 spec 或 proposal 引用，但 spec-writer 只能写 spec | 「范围外」类的决定（如 Q-4 不发欢迎邮件）被 agent 写成了新的 Requirement/AC-8，需求被不必要地扩充 | 可让 spec-writer 也能写 proposal 的「范围外」一节，或允许问题标记为「范围外，无需引用」 |
| 修复前创建的评论没有上下文 | 原文不唯一时仍可能被定位到同文的另一行 | 只影响旧评论；可重新打开后由人重新评论 |
| G5 以测试文件为粒度 | 修改已有测试文件时，文件中任一测试先失败即算 RED，不能确认每个新测试都先失败 | 需要逐个测试的结果（如 JUnit XML / TAP 逐条解析）；T3.6 只解析了总数 |
| 本机没有 `rtk` 命令 | `AGENTS.md`（用户目录）要求的 rtk 前缀无法使用 | 用原生命令 |

---

## 实测记录

### 2026-11-12 · DeepSeek（`deepseek-v4-pro`）· 示例项目 `/tmp/sf-ds-demo`（临时目录，可能已不存在）

| 运行 | 接法 | 结果 | 轮数 | tokens 输入+输出 | 耗时 |
|---|---|---|---|---|---|
| 需求分析 | `deepseek` | 成功：复述、10 节点分解树、5 假设、5 问题（1 阻塞），主动发现"导入可创建 admin"的提权风险 | 40 | 9K+14K | 241s |
| 审查 1 | `openai-compatible` + deepseek | 正确判 fail：抓到故意埋的漏洞（`role: row.role \|\| 'member'`），锚定 Q-1 | 5 | 85K+6K | 105s |
| 审查 2（修复后） | `deepseek` | pass，覆盖 AC-1~3 | 12 | 24K+8K | 147s |
| 分析重跑（修复 `cd9ece1` 后） | `deepseek` | 成功，但仓库里已有导入实现，只提了 2 个技术问题，**无法判断修复效果** → 见 T2.3v | 48 | 37K+17K | 268s |

| T2.3v 干净仓库分析 | `deepseek` | 成功：12 节点、4 假设、8 问题；新提出"仓库没有服务/CLI/UI，交付形态是什么"（范围，阻塞，dev+product） | 44 | 8K+18K | 276s |

T2.3v 分类结果：Q-1 范围、Q-3 用户与角色（能否导入 admin）、Q-4/Q-5 业务规则、Q-6 交互体验 → dev+product ✅；Q-2 CSV 格式（输入与校验）、Q-7 行数上限（边界值）、Q-8 是否做审计（可观测性）→ dev。Q-2 偏技术，可接受；Q-7、Q-8 属业务决策，归类不当 → 结论：prompt 约束显著改善但不可靠，需要人工兜底（T2.3w）。

| T2.6v 实现 T-1 | `deepseek` | 成功：新增 `src/import.js` 与 `test/import.test.js`，引擎提交 `5d4f4d0`，测试 3/3 | 13 | 7K+4K | 64s |
| T2.6v 实现 T-2（2026-11-13） | `deepseek` | 成功：入口加 `requireAdmin`，补 AC-3 测试，引擎提交 `c57cbc3`，测试 4/4 | 13 | 8K+2K | 20s |
| T2.8 spec-writer 第 1 次 | `deepseek` | 未提交 spec，提出 2 个阻塞问题（Q-2 行号编号、Q-3 表头非法/空文件），问题回流生效 | 18 | 15K+6K | 71s |
| T2.8 spec-writer 第 2 次 | `deepseek` | 成功：7 个 AC，引用 Q-1~Q-3，校验规则取自现有 `users.js` | 12 | 8K+8K | 88s |
| T2.8 architect | `deepseek` | 成功：复用 `requireAdmin` / `createUser`，结构变更 S-1 `src/csv.js`、S-2 `src/import.js`，覆盖 7 个 AC | 15 | 19K+13K | 156s |
| T2.8 planner | `deepseek` | 成功：2 个任务覆盖全部 AC 与 S，G4 一次通过 | 8 | 7K+10K | 122s |
| T3.5 修订第 1 次 | `deepseek` | 3 条评论（C-1 细化错误信息 / C-2 role=admin 建管理员 / C-3 发欢迎邮件）：没有直接加功能，就 C-3 提出阻塞问题 Q-4（是否纳入范围），未提交 | 4 | 6K+3K | 40s |
| T3.5 修订第 2 次（Q-4 答「范围外」后） | `deepseek` | 成功：C-1 已修改（只改 AC-5 一行）；C-2 不修改（引用 Q-1）；C-3 不修改（引用 Q-4），但新增了 Requirement「不发送欢迎邮件」/ AC-8；评论均为「已回应」，G2 仍等人确认 | 6 | 13K+9K | 85s |
| T2.6v 审查 | `deepseek` | pass，覆盖 AC-1~3；2 条次要意见（缺"CSV 含 role 列"用例、未 trim） | 12 | 13K+5K | 41s |

T2.6v 发现：模型用 `/private/var/...` 写 worktree 文件被误判为"工作目录之外"（macOS `/var` 是符号链接）→ `writeDenial` 改为先解析符号链接，已加回归测试。

T2.6v 示例项目：仓库含 `src/users.js`、`src/upload.js`、`src/auth.js`（同第一次演示）；change `bulk-import`（M 档），spec 含 AC-1 导入合法文件、AC-2 部分失败（行号+原因）、AC-3 非管理员拒绝；design 结构变更 S-1 `src/import.js`、S-2 `test/import.test.js`；tasks：T-1（AC-1, AC-2, S-1, S-2）、T-2（AC-3）依赖 T-1；agents.default.backend = deepseek。

**发现**：第一次分析把"CSV 列定义 / 能否创建 admin"归为"输入与校验"（只需 dev 确认），绕过了产品核对 → 已在 `cd9ece1` 修复（分类限定在确认策略内 + prompt 规则），待 T2.3v 确认。

---

## 变更日志

在这里追加，格式：`日期 · 工具/模型 · 任务 ID · 做了什么 · 提交`

- 2026-11-12 · Claude Code (Opus 5.5) · T1.1–T1.6 · 第一期完成 · `360ead2`
- 2026-11-12 · Claude Code (Opus 5.5) · T2.1–T2.2 · Claude agent 框架、分析与审查 agent · `b31d8a1`
- 2026-11-12 · Claude Code (Opus 5.5) · T2.3 · DeepSeek / Codex / OpenAI 兼容后端 · `7154743`
- 2026-11-12 · Claude Code (Opus 5.5) · T2.3 · DeepSeek 实测；问题分类修复 · `cd9ece1`
- 2026-11-12 · Claude Code (Opus 5.5) · — · 建立本任务清单与交接规则 · `4df0a08`
- 2026-11-12 · Claude Code (Opus 5.5) · T2.3v, T2.3w · DeepSeek 干净仓库实测（部分通过）；新增追加确认角色命令 · `0e66087`
- 2026-11-12 · Claude Code (Opus 5.5) · T2.4 · G3 方案门、design 阶段、`sf design approve` · `a3f30a4`
- 2026-11-12 · Claude Code (Opus 5.5) · T2.5 · G4 任务门、tasks 阶段 · `536f636`
- 2026-11-12 · Claude Code (Opus 5.5) · T2.6 · 可写实现 agent（worktree 隔离、双重路径校验、引擎提交） · `1ebb54a`
- 2026-11-12 · Claude Code (Opus 5.5) · T2.6v · DeepSeek 实现 T-1 成功；修复符号链接路径误拦截；收工，T-2 待继续 · `fe99f90`
- 2026-11-13 · Claude Code (Opus 5.5) · T2.6v · DeepSeek 实现 T-2，验证、agent 审查、签字，交付完成 · `e756239`
- 2026-11-13 · Claude Code (Opus 5.5) · T2.7 · G5 TDD 门（runner 只跑指定测试、实现合入前先红后绿、`sf tdd`） · `8fc8cff`
- 2026-11-13 · Claude Code (Opus 5.5) · T2.10 · 实现阶段起 OpenSpec 文件按 HEAD 读取 · `76dd751`
- 2026-11-13 · Claude Code (Opus 5.5) · T2.9 · 问题回流：后续阶段 agent 提问、任务级暂停 · `adc28f8`
- 2026-11-13 · Claude Code (Opus 5.5) · T2.11 · 打回与修复轮次上限、升级给人 · `6597904`
- 2026-11-13 · Claude Code (Opus 5.5) · T3.6 · 测试数量不得下降（G6A） · `cb90838`
- 2026-11-13 · Claude Code (Opus 5.5) · T2.8 · 生成类 agent（spec-writer / architect / planner），DeepSeek 实测 · `3039a81`
- 2026-11-13 · Claude Code (Opus 5.5) · T3.1 · server：只读 REST + WebSocket、SQLite 索引；Store 移到 packages/store · `f8768dc`
- 2026-11-13 · Claude Code (Opus 5.5) · T3.2 · Web 只读控制台（看板、门禁面板与证据、事件时间线） · `95f86bf`
- 2026-11-13 · Claude Code (Opus 5.5) · T3.3 · 需求分析视图（分解树、问题卡片、核对历史） · `f581de0`
- 2026-11-13 · Claude Code (Opus 5.5) · T4.1 · 用户名册、CLI 身份校验、Web 令牌登录；全局测试超时调为 20 秒 · `538d0ff`
- 2026-11-13 · Claude Code (Opus 5.5) · T3.4 · 控制台写操作（问题、复述、假设、审批、签字/打回、推进），写操作与 CLI 共用 store/actions；浏览器端到端测试 · `767052e`
- 2026-11-13 · Claude Code (Opus 5.5) · T3.4 · 接管：任务由人接手实现（sf task、控制台任务面板），agent 跳过 · `4cc5c60`
- 2026-11-13 · Claude Code (Opus 5.5) · T3.5 · 产物审阅器：行内评论、门禁、生成类 agent 按评论修订 · `2184e14`
- 2026-11-13 · Claude Code (Opus 5.5) · T3.5 · DeepSeek 实测修订模式；修复同文行导致的评论误定位（评论记录上下文） · （本次提交）
