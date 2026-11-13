# SpecForge 设计文档（v0.1）

> 名称暂定。SpecForge 是一个自建的 AI 研发流程平台：把 AI 的开发工作纳入
> **需求分析 → 规格 → 方案 → 任务 → 实现 → 收尾验证 → 交付** 的流水线，
> 并由引擎强制执行门禁、采集证据、全程留痕；同时给开发者提供可视化控制台。

---

## 0. 背景与定位

### 0.1 要解决的问题

AI 写代码的瓶颈已经不在"能不能写"，而在于：

1. **不可控**：需求理解偏了，AI 照样写得很自信；范围悄悄扩大。
2. **不可见**：人不知道 AI 做到哪一步、为什么这么做。
3. **不可验**：所谓"测过了"只是 AI 的一句话，没有可信证据。
4. **不可追溯**：需求里的问题是怎么定的、谁拍的板，没有记录。

### 0.2 参考与差异化

| 参考对象 | 借鉴 | SpecForge 的差异 |
|---|---|---|
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) | change 目录结构与 spec 格式（Requirement / Scenario） | **直接兼容**，不另造格式 |
| [SuperSpec](https://github.com/PeterYaoYang/SuperSpec) | 引擎强制门禁、收尾双子门禁（独立验证 + 独立审查）、RED→GREEN、可回放事件日志 | 证据由**引擎亲自重跑**（SuperSpec 是登记执行者上报的结果）；增加问题节点与 Web 控制台 |
| [MAIster](https://github.com/maister-dev/maister) | 自建控制台、每次运行独立 worktree、多 agent 后端 | 内置需求分析与追溯链，而非通用工作流编排 |
| Spec Kit / Kiro | 宪法、`[NEEDS CLARIFICATION]`、可测试的验收标准 | 门禁是强制的，不是约定 |
| obra/superpowers | verification-before-completion：先有证据再下结论 | 由引擎执行，而不是靠技能提示 |

**SpecForge 独有的部分**：需求问题节点 + 开发与产品双方核对 + 防篡改留痕 + 追溯链（问题 → AC → 任务 → 测试）。

### 0.3 目标用户与部署

- 当前：个人开发者，部署在本机（自建服务）。
- 设计上面向：小团队、公司内部团队。第一期不做权限体系，但在数据模型中保留身份与角色。
- 项目类型不限：平台不关心目标项目的语言，所有验证命令都由项目配置声明。

---

## 1. 设计原则

| 原则 | 含义 |
|---|---|
| **P1 默认未验证** | 每个门禁的初始状态都是 `unverified`，只有引擎拿到证据才能改成 `passed`。没有证据就等于没做。 |
| **P2 AI 不能推进流程** | 状态机只存在于引擎中。AI 没有任何"进入下一阶段"的工具，只能提交产物、申请检查。 |
| **P3 证据由引擎采集** | AI 声称"测试通过"一律不采信。测试、lint、构建都由引擎在隔离 worktree 中重新执行，记录命令、退出码、输出和 commit SHA。 |
| **P4 证据与内容绑定，内容一改就失效** | 审批与证据绑定内容哈希或 commit SHA。上游内容变化，下游门禁自动失效。 |
| **P5 全程留痕且防篡改** | 所有 AI 动作、门禁判定、人工操作写入只追加的哈希链事件日志；绕过引擎直接改状态文件可以被检测出来。 |
| **P6 引擎只守必须固定的东西** | 门禁只约束阶段顺序、人的决定、证据一致性；怎么调查、怎么实现交给模型。（借鉴 SuperSpec："模型越强，工作流逻辑应该越少"。） |
| **P7 按任务大小分档** | S / M / L 三档，小改动不走重流程。 |

---

## 2. 总体流程

```
需求输入
  │
  ▼
[1 需求分析] ⇄ 问题节点（开发 + 产品核对后回答）   ── G1 理解门
  │   ↑ 后续任何阶段遇到歧义都可以新建问题节点，回流到这里
  ▼
[2 规格 spec]   OpenSpec: proposal.md + specs/**/spec.md  ── G2 规格门
  ▼
[3 技术方案]    OpenSpec: design.md                       ── G3 方案门
  ▼
[4 任务拆分]    OpenSpec: tasks.md                        ── G4 任务门
  ▼
[5 实现]        每个任务 TDD（先红后绿）                  ── G5 TDD 门
  ▼
[6 收尾]        双子门禁：6A 验证门 + 6B 审查门            ── G6
  ▼
[7 交付]        PR / 合并 / OpenSpec archive
```

### 2.1 分档

| 档位 | 适用 | 流程 |
|---|---|---|
| **S** | 小修复、文案、配置 | 需求复述 + 阻塞问题检查 → 实现 → G6 |
| **M** | 一般功能 | 完整流程；人工审批 spec |
| **L** | 大特性、架构变更、对外契约变化 | 完整流程；spec、方案、最终验收都需人工审批 |

档位**可升不可降**（借鉴 SuperSpec）：出现推翻选档依据的新事实时自动要求升档；降档只能由人明确决定并留痕。

### 2.2 打回与重试

- 审查或验证失败时，带着失败原因回到对应阶段；每个 change 有最大修复轮次（默认 3），超过后升级给人处理。
- 已实现（审查）：closing 阶段写入 fail 的审查记录（agent 审查或开发者签字）后，引擎自动打回 implement 并开启修复轮次 n（`stage.sent_back`，记录被审 commit 与阻塞问题）；已用掉 `workflow.maxFixRounds` 轮时改为升级（`change.escalated`），停在 closing，不再自动打回，`sf agent implement` 拒绝运行，由人接手。
- 修复轮次中 `sf agent implement` 进入修复模式：prompt 只带本轮阻塞问题，不做新任务、不勾选任务清单、不做 G5（由回到收尾后的重新验证与审查把关）；有未回答的阻塞问题时暂停。离开 implement 时必须在打回之后有新提交，否则拒绝；通过后记录本轮的 `resolvedSha`。
- 验证（6A）失败暂不自动打回：可能是环境问题，由人判断。
- 审查提出的阻塞问题必须**锚定到已批准的材料**（某条 AC、某个任务、design 中的某项），并标注类型：漏做 / 破坏已有 / 计划外新增。修复只兑现锚点；审查建议里的新架构不构成授权。

---

## 3. 需求分析与问题节点

### 3.1 需求分析产物

需求分析 agent 读取需求和**现有代码库**（只读），输出 `.specforge/changes/<id>/analysis.json`：

| 部分 | 内容 | 门禁要求 |
|---|---|---|
| **需求复述** | AI 用自己的话重述"做什么、为谁做、为什么做" | 人确认，确认绑定复述内容的哈希 |
| **需求分解树** | 目标 → 功能点 → 场景（正常 / 异常 / 边界） | 问题节点挂在树节点上 |
| **影响范围** | 涉及的模块、文件、接口、数据表 | 由代码扫描得出，作为问题依据 |
| **假设清单** | AI 做出的假设 | 每条都必须被确认或否决 |
| **问题节点** | 见 3.2 | 见 3.4 |
| **维度覆盖表** | 每个分析维度标记 covered / question / n/a | n/a 必须写原因 |

**分析维度**（可在项目配置中定制）：用户与角色、输入与校验、状态流转、异常与错误、边界值、并发与幂等、数据迁移与兼容、性能、安全与权限、可观测性、交互体验、范围外事项。

### 3.2 问题节点结构

```jsonc
{
  "id": "Q-3",
  "nodeId": "F2.S1",                  // 挂在分解树的哪个节点
  "category": "边界与异常",
  "severity": "blocking",             // blocking / important / minor
  "question": "导入文件超过 10MB 时应该如何处理？",
  "why": "决定是否需要分片上传，影响接口设计和前端交互",
  "evidence": "src/upload/handler.ts:42 当前限制为 5MB",
  "options": [
    { "id": "A", "text": "直接拒绝并提示", "impact": "改动小", "recommended": true },
    { "id": "B", "text": "支持分片上传", "impact": "新增接口，工作量约 +2 天" }
  ],
  "defaultOptionId": null,            // blocking 问题不允许有默认答案
  "requiredRoles": ["dev", "product"],// 由分类和项目策略决定
  "status": "open",                   // open / drafted / confirmed / deferred / invalidated
  "dependsOn": ["Q-1"],
  "raisedAtStage": "analysis",
  "raisedBy": { "name": "analysis-agent", "role": "agent" },
  "revisions": [ /* 见 3.3 */ ]
}
```

### 3.3 回答与核对流程（开发 + 产品）

问题由**开发人员和产品核对后回答**。每次回答是一个**不可修改的修订版本（revision）**：

```
open ──(开发起草答案)──▶ drafted ──(所需角色全部确认)──▶ confirmed
  ▲                        │
  └──(任一方驳回，附意见)───┘

confirmed ──(需要改答案)──▶ 新建修订版本（必须填写变更原因）──▶ drafted ──▶ …
          └─ 旧版本保留，标记为 superseded；下游门禁自动失效
```

- **确认角色由策略决定**（`confirmPolicy`）：业务类问题（业务规则、范围、用户与角色、交互体验）默认需要 `dev + product`，技术类问题只需要 `dev`。
- **提出答案即视为提出者所属角色确认**。其余角色需要单独确认。
- **代录**：产品方不一定直接操作系统。开发者可以代为录入产品方的确认，但必须填写核对渠道（`via`：会议纪要链接、IM 消息链接等），记录为 `recordedBy: 开发者, onBehalfOf: 产品方`，界面上显示为"代录"。
- **不可删改**：答案不能被编辑，只能被新版本取代；驳回、推迟、作废都必须写原因。
- **每一个动作都写入事件日志**：谁、什么角色、什么时候、通过什么渠道、做了什么、答案内容的哈希。

每次确认记录的字段：

```jsonc
{
  "role": "product",
  "actor": { "name": "王五", "role": "product" },
  "at": "2026-11-12T10:20:00Z",
  "via": "https://wiki/meeting/2026-11-12",   // 核对渠道
  "recordedBy": { "name": "olivia", "role": "dev" }, // 代录时存在
  "note": "按方案 A，后续版本再考虑分片"
}
```

### 3.4 G1 理解门

以下条件缺一不可：

1. 需求复述已被确认，且确认时的哈希等于当前复述的哈希。
2. 所有 `blocking` 问题为 `confirmed`。
3. 所有 `important` 问题为 `confirmed` 或 `invalidated`（接受默认答案也要走确认，引擎不替人选）。
4. 所有 `minor` 问题为 `confirmed`、`deferred`（写明原因）或 `invalidated`。
5. 假设清单逐条已确认或否决。
6. 维度覆盖表中每个维度都有结论；`n/a` 必须写原因；`question` 必须关联至少一个问题节点。

### 3.5 问题回流

- 后续阶段的所有 agent 都有 `raise_question` 工具，系统规则写死：**遇到歧义必须提问，不许猜**。
- 新增的 `blocking` 问题会让 G1 失效，从而阻止流程继续推进；互不依赖的任务可以继续。
- **任务级暂停**：问题可关联任务（`taskIds`；实现 agent 提问默认关联当前任务，人工用 `sf q add --tasks`）。未解决的阻塞问题暂停关联任务及传递依赖它们的任务；没有关联任务时暂停全部任务。`sf agent implement` 不会选择被暂停的任务，`sf status` 列出暂停原因。
- 实现 agent 提出阻塞问题后不能再 `finish_task`，本次改动丢弃（`implement.blocked`）；问题由引擎在运行结束后通过 `Store.mutate` 写入（`question.raised`），即使运行失败也保留。审查 agent 提出的问题同样入库。
- 答案被新版本取代时，G1 的绑定哈希变化，下游 G2…G6 随之失效。
- 审查 agent 专门检查"未经提问的假设"：代码里写死的业务规则在 spec 和问题答案中找不到依据，就判为阻塞问题。

### 3.6 生成类 agent（T2.8）

- `sf agent spec|design|plan <id>`，分别在 spec / design / tasks 阶段运行；agent 对工作区只读（运行前后指纹校验）。
- 产物通过 `submit_spec` / `submit_design` / `submit_tasks` 提交草稿，引擎用 G2/G3/G4 的同一套检查（人工审批项除外）校验，不通过把问题返回给 agent 修改；通过后由引擎写入 `openspec/changes/<id>/`（路径由引擎拼出），记录 `artifact.generated`（含文件哈希）。已有产物默认不覆盖（`--force`）。
- 审批、提交、推进仍由人完成；agent 遇到歧义用 `raise_question`，提出阻塞问题后可不提交。

---

## 4. 门禁体系

### 4.1 门禁清单

| 门禁 | 阶段 | 引擎自动检查 | 人工 | 绑定对象 |
|---|---|---|---|---|
| **G0 宪法门** | 项目接入 | 配置存在；验证命令在干净 worktree 能跑通 | 首次确认 | 配置哈希 |
| **G1 理解门** | 需求分析 | 见 3.4 | 确认复述、回答问题 | 分析 + 问题的哈希 |
| **G2 规格门** | spec | 每个 Scenario 有唯一 AC 编号；每个已确认问题被 spec 或 proposal 引用；不存在追溯不到来源的需求（第二期） | M/L 档需审批 | spec 文件哈希 + G1 哈希 |
| **G3 方案门** | design | 覆盖全部 AC 且不引用不存在的 AC；有「## 结构变更」清单（`- [S-n] …`，无变更写 `- 无：<原因>`）；审查 agent 据此判断计划外新增 | L 档，或结构变更涉及受保护路径时需审批 | design 哈希 + G2 哈希 |
| **G4 任务门** | tasks | 每个任务关联 AC 和设计条目；依赖无环 | — | tasks 哈希 + G3 哈希 |
| **G5 TDD 门** | 每个任务（M/L 档；离开实现阶段时要求全部任务满足） | 引擎确认新测试先失败（RED），实现后通过（GREEN），见 4.3 | — | 任务尝试 + commit |
| **G6 双子门禁** | 收尾 | 见 4.2 | 最终签字 | commit SHA |

### 4.2 G6 双子门禁

两道门**并列**，缺一不可，且**必须绑定同一个 commit SHA**。

**6A 验证门（机器证据）**
- 引擎在**干净 worktree**（从该 commit 检出）中执行项目声明的全部验证步骤（install / lint / typecheck / test / build），所有步骤退出码为 0。
- **AC 覆盖**：spec 中每个 AC 编号都出现在该 commit 的测试文件中。
- **防作弊**：从 change 基线到该 commit 的 diff 中，不得新增跳过测试的标记（`.skip`、`xit`、`@Ignore`、`pytest.mark.skip`、`t.Skip` 等）；不得改动受保护路径（CI 配置、测试配置、lint 规则、覆盖率阈值）。命中的话转为人工审批。
- **测试数量不得下降**：从验证步骤（默认 `test`，可配 `testReport.step`）的输出解析测试总数，自动识别 node --test / vitest / jest / pytest / mocha / cargo，其他运行器用 `testReport.pattern`（第一个捕获组为总数）。基线是 change 的 `baseSha`：`sf verify` 首次运行时同时验证基线并记录证据。当前数量 < 基线数量、无法解析、缺基线证据都不通过；基线中没有测试文件时基线视为 0。

**6B 审查门（独立判断）**
- **独立审查 agent**：新开上下文，只看 spec、design 和 diff，不看实现过程；必须给出覆盖范围回执；不能有阻塞问题。
- **开发者签字**：在控制台查看 diff、证据和审查结论后签字。
- 两者都必须针对同一个 commit。

**失效规则**：任一方完成之后出现新提交，6A 和 6B 全部失效，重新验证。

**读取来源**：进入 implement 阶段后，所有门禁（含 G2–G5）读取 HEAD 中的 OpenSpec 文件，AC 列表与 AC 覆盖来自同一个 commit；工作区中未提交的 OpenSpec 改动不参与评估（`sf status` 会提示）。之前的阶段读工作区，便于人在提交前编辑。

### 4.3 G5 TDD 门

- **测试文件**：任务 commit 相对任务开始前 commit（base）**新增或修改**的、匹配 `testGlobs` 的文件（删除的不算）。没有测试文件即不通过。
- **RED**：从 base 检出干净 worktree，只放入这些测试文件，执行 `tdd.setup`（可选）和 `tdd.command`（`{files}` 替换为加引号的文件列表）。退出码必须非 0；超时不算失败证据。
- **GREEN**：从任务 commit 检出干净 worktree，执行同一组测试，退出码必须为 0。
- `sf agent implement`：引擎在合入前执行；不通过则整体丢弃（`implement.rejected`），证据仍然记录。手工实现的任务用 `sf tdd <id> <T-n> --base <sha>` 补证据。
- **门禁**（`implement` 阶段的出口门，并在 closing 中持续有效）：已配置 `tdd.command`；tasks.md 中所有任务已勾选；每个任务至少有一份通过的证据，且其 commit 仍在当前 HEAD 的历史中（改写历史会使证据失效）。绑定每个任务被采信的证据 id 与 commit。
- 证据文件 `evidence/tdd-*.json`，事件 `tdd.recorded` 记录证据哈希；文件被改动后不再采信。
- 已知局限：以文件为粒度——修改已有测试文件时，只要文件中任一测试在 base 上失败即视为 RED，无法确认每个新测试都先失败；RED 无法区分"断言失败"与"模块不存在"等原因。

---

## 5. 强制执行机制

| 层 | 机制 | 说明 |
|---|---|---|
| ① 流程层 | 状态机只在引擎中 | AI 只能调用 `submit_artifact` / `request_gate_check` / `raise_question` |
| ② 工具层 | 按阶段控制工具权限 | Claude Agent SDK：`canUseTool` + hooks；其他后端用各自的沙箱模式 |
| ③ 证据层 | 引擎亲自执行验证 | 结果只认引擎采集的证据 |
| ④ 防作弊层 | diff 扫描 + 事后校验 | 每轮 agent 执行后，引擎检查 worktree 的改动是否越界，越界则回滚并拒收 |

**事后校验是兜底**：不同 agent 后端的拦截能力不同（见 6.2），所以不能只依赖执行时拦截。每轮 agent 结束后，引擎都对 worktree 做一次统一检查：改动的文件是否在本阶段允许的路径内、是否碰了受保护路径、是否改了已批准的 spec。这保证无论用哪个后端，约束强度都一致。

各阶段的路径权限示例：

| 阶段 | 可写 | 禁止 |
|---|---|---|
| 需求分析 | 无（只读） | 所有写操作 |
| spec / design / tasks | `openspec/changes/<id>/**` | 源码 |
| 实现 | 源码、测试 | `openspec/changes/<id>/specs/**`、受保护路径、`git push` |
| 审查 | 无（只读） | 所有写操作 |

---

## 6. Agent 后端

### 6.1 适配层

```ts
interface AgentAdapter {
  id: 'claude' | 'codex' | 'deepseek' | string;
  capabilities: AgentCapabilities;
  run(task: AgentTask, ctx: AgentContext): AsyncIterable<AgentEvent>;
}

interface AgentTask {
  role: 'analyst' | 'spec-writer' | 'architect' | 'planner' | 'implementer' | 'reviewer';
  prompt: string;            // 角色 prompt + 输入产物
  cwd: string;               // 本次运行的 worktree
  policy: PathPolicy;        // 本阶段的可写路径
  tools: PlatformTool[];     // raise_question / submit_artifact / request_gate_check
}
```

### 6.2 支持的后端

| 后端 | 接入方式 | 执行时拦截 | 备注 |
|---|---|---|---|
| **Claude** | Claude Agent SDK（TypeScript） | 强：`canUseTool`、PreToolUse hooks，可以细到单个工具调用 | 默认后端 |
| **Codex** | Codex SDK：`read-only` 沙箱、禁网；不支持进程内工具，改为结构化输出整批提交平台工具调用，校验失败则清空草稿重交 | 中：沙箱 + 事后校验 | |
| **DeepSeek** | 两条路都已实现：① `deepseek`：Anthropic 兼容接口 + Claude Agent SDK；② `openai-compatible` + `provider: deepseek`：自研 agent 循环（回传 `reasoning_content`） | ① 同 Claude；② 只提供引擎实现的只读工具 | 待实测哪条更稳定 |
| **任意 OpenAI 兼容服务** | `openai-compatible`（预设 ollama，或直接配 baseUrl） | 只提供引擎实现的只读工具 | |

平台工具（`raise_question` 等）通过 **MCP server** 暴露，三种后端都能使用。

角色可以绑定不同后端，例如实现用 Claude，审查用 Codex。**审查者和实现者用不同模型**，独立性更强。

---

## 7. 证据与留痕

### 7.1 事件日志（哈希链）

`.specforge/events.jsonl`，只追加：

```jsonc
{
  "seq": 42,
  "at": "2026-11-12T10:20:00Z",
  "actor": { "name": "olivia", "role": "dev" },
  "type": "question.confirmed",
  "changeId": "add-bulk-import",
  "payload": { "questionId": "Q-3", "rev": 2, "role": "product", "via": "..." },
  "stateHash": "…",     // 本次操作后 change 状态文件的哈希
  "prevHash": "…",      // 上一条事件的 hash
  "hash": "…"           // sha256(以上所有字段的规范化 JSON)
}
```

- `sf log verify` 校验整条链；任何一条事件被修改或删除，都会导致后续哈希对不上。
- 每条事件记录操作后的 `stateHash`。如果当前状态文件的哈希和最后一次记录的不一致，说明有人绕过引擎直接改了文件，会被报告为**带外修改**。
- 注意：本机单用户场景下，哈希链能防误改、能发现篡改，但不能防止有意重写整条链。团队阶段会把链头哈希定期锚定到服务端或 git 提交中。

### 7.2 证据记录

```jsonc
{
  "id": "ev-20261112-a1b2c3d",
  "sha": "a1b2c3d…",
  "startedAt": "…", "finishedAt": "…",
  "mainTreeDirty": false,
  "steps": [
    { "name": "test", "command": "npm test", "exitCode": 0, "durationMs": 5230,
      "outputTail": "…最后 8KB…", "outputHash": "…" }
  ],
  "host": { "node": "v22.22.3", "platform": "darwin" }
}
```

---

## 8. 存储与 OpenSpec 兼容

### 8.1 目标项目中的目录

```
<project>/
├── openspec/                        # OpenSpec 原生目录，保持兼容
│   ├── specs/                       # 已归档的长期 spec
│   └── changes/<change-id>/
│       ├── proposal.md
│       ├── design.md
│       ├── tasks.md
│       └── specs/<capability>/spec.md
└── .specforge/                      # 平台数据，提交到 git
    ├── config.json                  # 项目宪法：验证命令、受保护路径、确认策略…
    ├── events.jsonl                 # 哈希链事件日志
    ├── identity.local.json          # 本机身份（不提交）
    └── changes/<change-id>/
        ├── change.json              # 档位、阶段、基线 commit
        ├── analysis.json            # 复述、分解树、假设、维度覆盖
        ├── questions.json           # 问题节点及全部修订版本
        ├── reviews.json             # 审查记录（agent + 人工签字）
        └── evidence/*.json          # 验证证据
```

### 8.2 AC 编号约定

在 OpenSpec 的 Scenario 标题中加上 AC 编号，仍然是合法的 OpenSpec：

```markdown
### Requirement: 文件大小限制
系统 SHALL 拒绝超过 10MB 的导入文件（Q-3）。

#### Scenario: [AC-1] 上传超限文件
- **WHEN** 用户上传 12MB 的文件
- **THEN** 返回错误提示"文件不能超过 10MB"
```

测试中引用 AC 编号，比如 `it('[AC-1] 拒绝超限文件', …)`，引擎据此计算覆盖率。问题编号（`Q-3`）写在 Requirement 正文中，用来建立追溯关系。

### 8.3 服务端存储

- 第一期（CLI）：直接读写 `.specforge/` 下的文件，文件即状态，git 即历史。
- 第二期（服务）：SQLite + Drizzle 作为索引和查询层，以文件为准；团队阶段可换成 Postgres。

---

## 9. 系统架构

```
┌─────────────────────────────────────────────────┐
│  Web 控制台（React + Vite）                      │
│  看板 / 流水线 / 需求分析 / 门禁面板 / 代码审查 / 收件箱 │
└──────────────────┬──────────────────────────────┘
                   │ REST + WebSocket
┌──────────────────▼──────────────────────────────┐
│  server（Hono）：编排调度、任务队列、MCP server     │
├─────────────────────────────────────────────────┤
│  core：状态机、门禁引擎、问题节点、哈希链（纯逻辑）  │
├──────────────┬──────────────────┬───────────────┤
│ runner       │ agents           │ store         │
│ worktree、    │ AgentAdapter:    │ .specforge 文件 │
│ 执行验证命令、  │ Claude / Codex / │ + SQLite 索引   │
│ 证据、防作弊    │ DeepSeek         │               │
└──────────────┴──────────────────┴───────────────┘
```

### 9.1 代码仓库结构

```
specforge/
├── packages/
│   ├── shared/   # 类型定义
│   ├── core/     # 状态机、门禁、问题节点、哈希链、spec 解析、路径策略
│   ├── runner/   # git / worktree、验证执行、AC 覆盖、防作弊扫描
│   ├── agents/   # AgentAdapter 与各后端实现、各角色 agent 的工具与 prompt
│   └── store/    # .specforge/ 读写（Store.mutate、哈希链）、OpenSpec 文件读取、门禁实时评估
├── apps/
│   ├── cli/      # 命令行 sf
│   ├── server/   # Hono：只读 REST + WebSocket 推送；SQLite 索引（T3.1）
│   └── web/      # React + Vite 只读控制台（T3.2）
└── docs/
```

技术栈：TypeScript 全栈；Node ≥ 22（直接运行 TS）；npm workspaces；vitest。

### 9.2 server（T3.1）

- **文件为准**：SQLite（`node:sqlite`，默认在内存中，启动时重建）只是 `.specforge/` 的索引，用于 change 列表、问题过滤、事件分页。详情、门禁评估、链校验直接读文件并实时计算，不缓存。
- **同步**：每个 REST 请求前、以及事件日志变化时（轮询 `events.jsonl`）按事件序号增量同步，只重建有新事件的 change；已索引的最后一条事件与文件不一致（日志被改写或截断）时全量重建。
- **REST（只读）**：`/api/changes`、`/api/changes/:id`（含带外修改与 OpenSpec 读取来源）、`/gates`、`/questions`、`/questions/:qid`、`/events`、`/api/events`、`/api/log/verify`。写操作在 T3.4 加入，仍只能走 `Store.mutate`。
- **WebSocket `/ws`**：推送 `hello` / `event` / `changes` / `rebuilt`；`?changeId=` 过滤，`?after=` 断线补发。推送进度独立于索引同步，REST 先同步也不会漏推。
- **安全**：默认只监听 127.0.0.1。启用用户名册后需要登录（见 9.3）；未启用时拒绝监听非本机地址。
- **证据接口**（T3.2）：`/api/changes/:id/evidence[/:eid]`，从事件日志列出验证证据与 G5 证据，`hashOk` 表示证据文件与事件中记录的哈希一致。`/gates` 同时返回 `pipeline`（阶段与出口门禁，来自 core 的 `pipelineFor`），前端不重复实现流程规则。

### 9.3 身份与登录（T4.1）

- **用户名册** `.specforge/users.json`：用户名、角色（dev / product，可多个）、是否管理员、是否停用、Web 登录令牌的 SHA-256。只能通过 `sf user add | set | token | disable` 修改（`Store.mutateUsers`），每次修改写入哈希链（`user.*` 事件记录名册哈希，事件中不含令牌哈希）。名册与最后一条 `user.*` 事件不一致、被删除、或不是由 sf user 创建时，一律拒绝使用（失败即关闭），不会退回兼容模式。
- **初始化**：名册为空时任何人可以添加第一个用户，且必须是管理员；之后只有管理员能加人、改角色、停用；令牌可由管理员或本人重置。不能失去最后一个可用管理员。
- **兼容模式**：没有名册时身份仍自行声明（旧行为），server 只能监听本机。
- **CLI**：启用后 `whoami --set`、`--as`、`--on-behalf` 的身份必须在名册中、未停用、且角色已授予；agent 角色不能由人声明。**局限**：CLI 直接读写本地文件，名册只能防止误用和冒名记录，不能防止有文件写权限的人篡改——篡改会被 `sf log verify` 与名册校验发现。
- **Web 登录**：令牌为 256 位随机数（`sf_` 前缀），只在生成时显示一次。`POST /api/auth/login`（仅接受 JSON）成功后发放 HttpOnly、SameSite=Strict 的会话 Cookie，12 小时过期；会话只在内存中，server 重启需重新登录。每次请求都回到名册核对，用户停用或令牌重置后会话立即失效。同一来源与用户名连续失败 5 次锁定 10 分钟。启用名册后，除 `/api/health` 与 `/api/auth/*` 外的接口（含 `/ws`）都需要登录。
- **传输**：server 不提供 HTTPS。监听非本机地址时会提示放在 HTTPS 反向代理之后。

### 9.4 Web 控制台（T3.2，只读）

- `apps/web`：React + Vite，hash 路由。`npm run web:build` 后由 server 托管（`apps/web/dist`，不提交）；开发时 `npm run web:dev`，接口代理到 4317。
- 页面：看板（按阶段分列，红点标出等人处理：阻塞问题、升级、修复轮次）；change 详情（阶段条，上游失效标黄；提示条：带外修改、升级、阻塞问题、修复轮次、未提交的 OpenSpec 改动；门禁面板逐项 ✓/✗，G5 / G6A 可点开证据）；证据页（RED / GREEN 或各验证步骤的命令、退出码、输出末尾，哈希不一致时警示）；事件时间线（按类别过滤，可展开载荷）。
- 实时：订阅 `/ws`，收到变化后重新读取 REST；断线指数退避重连，带 `after` 补发。
- 视图逻辑放在 `src/model.ts`（纯函数，有测试），组件只做展示。
- **需求分析视图**（T3.3）：change 详情的「需求分析」标签页，`#/changes/:id/analysis[/:qid]` 可深链接到问题。内容：需求复述及确认状态（确认后被改动会标出）；分解树（目标 → 功能 → 场景，问题徽标挂在节点上，阻塞数向上累加；没有节点的问题单列）；问题卡片（严重程度、分类、状态、为什么问、依据、选项与推荐/默认/已选、需要的角色与当前版本还缺的角色、依赖、关联任务、暂停的任务）；完整核对历史（提出、各版本答案与修改原因、每次确认含代录人与渠道、驳回、推迟/作废）；假设；维度覆盖表。
- 「还缺哪些角色确认」「哪些任务被暂停」「复述是否仍有效」由 server 用 core 的规则计算后返回（`questionProgress`、`pausedTasks`、`restatementConfirmed`），前端不重复实现。

### 9.5 控制台写操作（T3.4）

- **前提**：项目启用了用户名册并已登录。没有名册时控制台只读（写接口返回 403），避免匿名修改。
- **身份**：登录用户 + 请求中选择的角色（顶栏切换，必须已授予），服务端用名册重新校验。所有写操作都调用 `@specforge/store` 的操作函数（`questionAction`、`confirmRestatement`、`decideAssumption`、`approve`、`signOff`、`advance`、`recordReview`），与 CLI 共用同一份代码与事件格式，最终走 `Store.mutate` 写入哈希链。
- **接口**：`POST /api/changes/:id/questions/:qid/{answer|confirm|reject|defer|invalidate}`（代录：`onBehalfName` + `onBehalfRole` + `via`，对象必须在名册中且有该角色）、`/restatement/confirm`、`/assumptions/:aid/decide`、`/approve`（dev）、`/signoff`（dev；不通过即打回，必须写原因，可附锚定的阻塞问题，收尾阶段会打回实现或升级）、`/advance`（门禁把关，不通过返回 409 并记录拒绝事件）。
- **防 CSRF**：所有 POST 只接受 `application/json`（跨站表单发不出），会话 Cookie 为 SameSite=Strict。
- **错误码**：角色或权限问题 403，门禁拦截与状态冲突（带外修改）409，参数问题 400。
- **端到端测试**：`npm run web:e2e`（需要本机 Chrome 与 `npm run web:build`）：真实浏览器中走完回答 → 产品确认 → 推进 → 审批 → 推进 → 被门禁拦截，最后校验事件身份与哈希链。不属于 `npm test`。
- 尚未实现：「接管」（设计文档第 10 节审批收件箱中的一项，含义待定）；新建 change、编辑复述 / 假设 / 维度、提问等仍用 CLI。

---

## 10. 开发者控制台（第二期）

1. **总览看板**：所有 change 处在哪个阶段，哪些在等人（红点）。
2. **需求分析视图**：左侧分解树（带问题徽标），右侧问题卡片（选项、推荐、影响、依据），支持代录产品方确认；可以查看每个问题的完整修订和核对历史。
3. **门禁面板**：逐项展示 ✅/❌，每项都能点开查看原始证据；被拦截时直接说明原因；失效的门禁显示为灰色，并注明因哪次变更失效。
4. **产物审阅器**：spec / design 行内评论，评论作为修改意见返回给 AI；显示版本 diff。
5. **代码审查视图**：diff + AI 审查意见 + AC 追溯。
6. **审批收件箱**：通过 / 打回并附意见 / 接管。
7. **审计视图**：事件日志时间线，哈希链校验状态。

---

## 11. 路线图

| 期 | 范围 | 验收标准 |
|---|---|---|
| **第一期** | shared / core / runner / cli；G1、G2、G6；问题节点 + 双方核对 + 留痕；哈希链；引擎验证 | 在示例项目上跑通：问题未确认被拦截 → 确认后通过；跳过测试被拦截；新提交使 G6 失效 |
| **第二期** | agents（Claude 优先，再接 Codex、DeepSeek）、MCP 平台工具、G3/G4/G5、server + 只读 Web 控制台 | AI 在约束下自动跑完 M 档流程 |
| 　↳ 已完成 | Claude 适配层（进程内 MCP 平台工具 + canUseTool 拦截 + 运行前后工作区指纹校验）；需求分析 agent；独立审查 agent（6B） | `sf agent analyze` / `sf agent review` |
| 　↳ 已完成 | G3 方案门、G4 任务门；可写实现 agent（worktree 隔离 + 执行时拦截 + 事后路径校验 + 引擎提交） | `sf agent implement` |
| 　↳ 已完成 | DeepSeek（两种接入）、Codex、通用 OpenAI 兼容后端 | `--backend deepseek\|codex\|openai-compatible` |
| **第三期** | 交互：行内评论、审批、打回、接管；并行任务；测试数量检查 | 开发者只在控制台完成全部人工决策 |
| **第四期** | 团队：身份与权限、多项目、Postgres、通知（IM） | 产品方直接登录确认问题 |

---

## 12. 待定事项

- DeepSeek 的接入方式（Anthropic 兼容接口 vs 自研循环）需要实测。
- 产品方的入口：第一期由开发者代录；第四期之前是否需要一个免登录的只读确认链接？
- 测试数量统计需要解析各语言的测试报告格式，第三期再定方案。
