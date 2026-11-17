# 飞书群通知（T4.5c）

当前已交付飞书适配器、逐项目后台 worker 和哈希链账本，默认关闭；验收只使用注入传输，没有向真实群发送。管理命令与完整登录回归在 T4.5d，指定测试群的真实发送在 T4.5e；`sf notify preview / status / retry` 尚不可用。范围和进度见 [方案](t4.5-plan.md) 与 [TASKS.md](TASKS.md)。

## 配置

可信服务端管理员维护独立 JSON，通过 `--notifications <文件>` 传入。下面是关闭状态的示例，不包含凭据值：

```json
{
  "version": 1,
  "projects": [{
    "projectId": "alpha",
    "enabled": false,
    "provider": "feishu",
    "alias": "项目 Alpha",
    "publicBaseUrl": "https://console.example.invalid",
    "webhookEnv": "SF_ALPHA_FEISHU_WEBHOOK",
    "signingSecretEnv": "SF_ALPHA_FEISHU_SECRET",
    "route": {
      "id": "alpha-team",
      "provider": "feishu",
      "revision": "v1",
      "members": [{ "name": "product-user", "memberId": "ou_example" }]
    }
  }]
}
```

```bash
# 多项目：通知 ID 必须来自项目登记；未列出的项目不启动通知。
node /opt/specforge/apps/server/src/main.ts --projects /srv/specforge/projects.json --notifications /srv/specforge/notifications.json

# 单项目：在项目目录运行，通知文件必须恰好配置一个稳定 projectId。
node /opt/specforge/apps/server/src/main.ts --notifications /srv/specforge/notifications.json
```

单项目若使用 Postgres 索引，通知 ID 必须与索引的 projectId 一致。各项目需要启用用户名册；同名账号、change、Q 和成员映射仍按项目分别处理。字段错误只暂停该项目通知，原业务仍可使用；外层 JSON / 重复或未登记 ID 错误会拒绝启动，避免错误寻址。配置文件在启动时读取，修改开关、路由或映射需正常关闭并重启服务。

Webhook 和签名密钥只从指定环境变量读取，不写进 JSON。首版要求机器人开启签名校验；只接受 `https://open.feishu.cn/open-apis/bot/v2/hook/<标识>`，拒绝其他主机、HTTP、用户信息、附加查询及重定向。Webhook 自身也属于凭据。缺少或非法凭据不会发请求，当前待办记为 blocked / configuration；修复配置不会自动恢复已经 blocked 的记录，显式重试由 d 交付。

成员必须由管理员显式绑定为飞书 Open ID（`ou_…`），且是该机器人所在群的有效成员；程序不会按邮箱、同名或全名册猜测。只有未停用且具有所需 dev / product 角色的映射成员会被 @。机器人自身不能查询群成员或确认管理员的映射是否正确，接口受理也不能证明 @ 生效；这部分由 e 在测试群验收。每个项目使用专用群，群内其他成员同样能看见消息。

`publicBaseUrl` 当前必须是固定的外部 HTTPS 根地址，不含部署路径、查询、片段或登录凭据。既有控制台只从根路径识别项目，任意反向代理前缀暂时拒绝配置，前缀适配在 d 的链接浏览器验收中完成。程序逐段编码对象 ID，生成单项目原路由或多项目 `/p/<id>/#/changes/…` 链接；链接仍需对应项目登录。消息只包含项目别名、change / Q / 答案版本与短哈希或签字 SHA、角色、通知编号和观察时间，不包含业务正文、标题、代码或验证输出。富文本使用结构化 text / at / a 节点，用户文本不能变成额外 @ 或链接。

当前示例保留关闭状态。完成 d 的首次待办预览、核对群成员和环境后，启用配置会补当前仍待处理事项；真实测试投递按 e 的指定群授权执行。

## 运行与结果

启动时扫描当前待办；后续业务事件会唤醒扫描，并每 5 秒复核一次 HEAD、门禁与名册。每项目最多一项在途请求，发送开始至少间隔 2 秒；无积压且仓库空闲时通常在 10 秒内开始首次尝试。业务请求不等待网络，A 的慢请求不占 A 的仓库写锁，也不阻止 B。仓库锁忙或长任务会延迟发送。

发送前再次校验当前版本、就绪条件和成员快照；不合条件的待发项取消。换群、Webhook 或路由 revision 会改变接收快照，旧待发项暂停，已 accepted 的不自动复制到新群。轮换签名密钥本身不改变去重键。通知事件通过 Store.mutate 写入原哈希链，SQLite / Postgres 只是可重建查询索引。

| 账本结果 | 含义 |
|---|---|
| accepted | HTTP 200 且飞书 `code: 0`；仅代表接口受理，不代表送达、已读或业务确认 |
| retry_wait | 明确的 11232 限流或 HTTP 429；10 / 30 / 120 / 600 秒退避并加最多 20% 抖动，遵守更晚的合法 Retry-After；最多共 5 次 |
| blocked / failed | 配置 / 映射不可用，或已知请求、签名、IP / 关键词错误、尝试耗尽；停止自动重试 |
| unknown | 10 秒超时、断线、5xx、缺少可靠业务码、矛盾响应，或遗留 started；默认不自动重发 |
| cancelled | 当前需求已结束或失效；安全的同键需求恢复沿用原预算，accepted / unknown 不自动复活 |

事件时间线中的 `notification.*` 可追溯通知状态；事件和错误不保存 Webhook、签名、密钥、原始成员 ID 或原始响应。请求限制为 20 KB，响应正文读取最多 32 KB。已受理后写锁忙只重试结果记账，不再次发送请求；每轮等待有界，仍无法落盘时暂停并保留内存结果，后续扫描先尝试记账。正常关闭停止新请求并等待在途请求完成或超时；重启从账本继续，未落盘的 started 保守归 unknown。

## 独占与恢复

worker 使用 Git common dir 下的 `specforge-notify.lock/owner.json` 保存 PID 与随机 owner token。这个长期所有权不占业务写锁；第二个活 worker 不能接管或把在途发送误判为中断。只有确认原 PID 不存在时，新的 owner 才在短期仓库锁内接替，再将遗留 started 记为 unknown。PID 被复用时保守拒绝接管，不靠租约超时强抢。

若项目保留 `specforge-write.lock` 或 `specforge-write.pending.json`，先按 [写入恢复说明](write-recovery.md) 核对业务一致性；通知不会自动绕过这些保护。源链、名册、状态、锚定或仓库绑定异常也暂停发送和结果记账，恢复原始可信文件后才能继续。

通知 owner 缺失、格式损坏或被外部替换时不会自动删除。此时先停止该仓库全部通知服务，备份仓库、事件链和两个锁目录，确认没有 worker / 在途请求；再由本机管理员离线移走无法使用的通知锁目录，重启后让新 owner 将遗留 started 归 unknown。只处理通知所有权文件，不能删除事件、pending、业务写锁或重建索引来清空发送历史。unknown 后续重试需要管理员明确接受重复风险，相关命令在 d 实现。

这是单服务器本地文件系统协议，继承现有写入恢复、Git 锚定和可信备份边界；不提供分布式 worker 或 exactly-once 送达保证。

## 契约依据与验证

实现依据：[飞书官方自定义机器人使用指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)（2026-11-16 读取其 Markdown 版本）。使用该文档的 HMAC-SHA256 空消息签名、post / at 节点、20 KB 上限、11232 限流及 9499 / 19021 / 19022 / 19024 错误语义；HTTP 429 按明确限流处理，其余不明响应保守归 unknown。尚无真实群受理或成员 @ 证据。

默认测试注入传输，包括签名固定向量、返回码矩阵、超时和断线、结果记账争用、两个活 owner、四个真实 SIGKILL 检查点、单 / 双项目服务、配置隔离和关闭；不使用真实 IM 或模型。管理入口、管理员重试和消息链接的浏览器集成验收仍由 d 完成。
