# 任务清单与状态

> 这是项目的**唯一进度来源**。任何 AI 工具或开发者接手时，先读 [AGENTS.md](../AGENTS.md) 的交接规则，再读本文件。
> 设计依据见 [design.md](design.md)。

状态：`done` 已完成并验证 · `doing` 进行中 · `todo` 待开始 · `blocked` 被阻塞 · `verify` 代码已完成、待实测确认

最后更新：2026-11-12 · Claude Code（Opus 5.5） · 提交 `cd9ece1` 之后

---

## 当前快照

- 测试：49 个全部通过（`npm test`），类型检查无错误（`npm run typecheck`）
- 已推送：https://github.com/yanling0220/specforge （`main`）
- **下一个建议任务：`T2.3v`**（确认问题分类修复的效果；花费很低），然后是 `T2.4`

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
| T2.3v | **确认问题分类修复（`cd9ece1`）有效**：在**干净的**示例仓库（只有现有代码、没有导入实现）上用 DeepSeek 跑分析，检查涉及业务决策的问题（列定义、能否创建 admin、部分成功）是否归到需要 product 确认的分类 | verify | T2.3 | 业务类问题的 `requiredRoles` 含 `product`；把结果写进"实测记录" |
| T2.3c | Codex 后端实测 | todo | T2.3 | 需要 Codex 登录；跑一次 `sf agent review --backend codex` 成功写入审查记录 |
| T2.4 | G3 方案门：解析 `design.md`；必须覆盖全部 AC；必须有"结构变更清单"（新增的模块/接口/表）；L 档需人工审批（绑定哈希） | todo | T1.3 | core 纯函数 + 测试；状态机加入 `design` 阶段 |
| T2.5 | G4 任务门：解析 `tasks.md`；每个任务关联 AC 与设计条目；依赖无环 | todo | T2.4 | 同上，加入 `tasks` 阶段 |
| T2.6 | 可写的实现 agent：按任务实现；每轮结束用已有的 `checkPathPolicy` 做事后路径校验，越界即回滚拒收；禁止改 spec 与受保护路径 | todo | T2.5 | 测试：越界写入被回滚并记录事件 |
| T2.7 | G5 TDD 门：引擎先确认新测试失败（RED），实现后通过（GREEN），绑定任务尝试与 commit | todo | T2.6 | runner 支持只跑指定测试；测试覆盖"先红后绿"和"测试一开始就通过"两种情况 |
| T2.8 | 生成类 agent：spec-writer（proposal→spec）、architect（→design）、planner（→tasks），只能写 `openspec/changes/<id>/**` | todo | T2.4, T2.5 | 生成结果仍需过 G2/G3/G4 |
| T2.9 | 问题回流：所有阶段的 agent 都能 `raise_question`；新阻塞问题使 G1 失效并暂停相关任务 | todo | T2.6 | 测试：实现阶段提问后 `advance` 被拦截 |
| T2.10 | spec 从 commit 读取，而不是工作区（目前 AC 列表读工作区、AC 覆盖读 commit，两者不一致） | todo | — | `readSpecFacts` 支持按 SHA 读取；G6 使用 HEAD 版本 |
| T2.11 | 打回与修复轮次上限：审查 fail 自动回到实现，超过上限升级给人 | todo | T2.6 | 配置 `workflow.maxFixRounds` |

## 第三期：服务与 Web 控制台

| ID | 任务 | 状态 | 依赖 | 验收标准 |
|---|---|---|---|---|
| T3.1 | server（Hono）：REST 读接口 + WebSocket 推送；SQLite 作为 `.specforge/` 的索引（文件为准） | todo | T2.* 主体 | 读接口覆盖 change、门禁评估、问题、事件 |
| T3.2 | Web 只读控制台（React + Vite）：看板、门禁面板（可点开证据）、事件时间线 | todo | T3.1 | |
| T3.3 | 需求分析视图：分解树 + 问题卡片 + 完整核对历史 | todo | T3.2 | |
| T3.4 | 交互：回答/确认/驳回问题、审批 spec、签字、打回、接管 | todo | T3.3 | 所有写操作仍走 `Store.mutate`，写入哈希链 |
| T3.5 | 产物审阅器：spec/design 行内评论，评论回传给 agent | todo | T3.4, T2.8 | |
| T3.6 | 测试数量不得下降（解析各语言测试报告） | todo | — | |

## 第四期：团队化

| ID | 任务 | 状态 | 验收标准 |
|---|---|---|---|
| T4.1 | 身份与登录、角色权限（目前身份是自己声明的） | todo | |
| T4.2 | 产品方直接登录或通过链接确认问题（替代代录） | todo | |
| T4.3 | Postgres、多项目 | todo | |
| T4.4 | 哈希链头定期锚定（git 提交或服务端），防止整条链被重写 | todo | |
| T4.5 | IM 通知（待确认问题、待签字） | todo | |

---

## 已知问题

| 问题 | 影响 | 计划 |
|---|---|---|
| 身份自行声明，无登录 | 任何人都能以产品身份确认 | T4.1 |
| 兼容接口（DeepSeek 等）不返回费用，`--budget` 不生效 | 只能看 token 数 | 可加按 token 的上限 |
| AC 列表读工作区，AC 覆盖读 commit | 未提交的 spec 改动会影响 G6 判断 | T2.10 |
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

**发现**：第一次分析把"CSV 列定义 / 能否创建 admin"归为"输入与校验"（只需 dev 确认），绕过了产品核对 → 已在 `cd9ece1` 修复（分类限定在确认策略内 + prompt 规则），待 T2.3v 确认。

---

## 变更日志

在这里追加，格式：`日期 · 工具/模型 · 任务 ID · 做了什么 · 提交`

- 2026-11-12 · Claude Code (Opus 5.5) · T1.1–T1.6 · 第一期完成 · `360ead2`
- 2026-11-12 · Claude Code (Opus 5.5) · T2.1–T2.2 · Claude agent 框架、分析与审查 agent · `b31d8a1`
- 2026-11-12 · Claude Code (Opus 5.5) · T2.3 · DeepSeek / Codex / OpenAI 兼容后端 · `7154743`
- 2026-11-12 · Claude Code (Opus 5.5) · T2.3 · DeepSeek 实测；问题分类修复 · `cd9ece1`
- 2026-11-12 · Claude Code (Opus 5.5) · — · 建立本任务清单与交接规则 · （本次提交）
