# 查询索引配置、迁移与回退

T4.3e 提供默认 SQLite 和显式可选 Postgres，二者都只是可丢弃的查询索引。项目的 `.specforge/`、OpenSpec、Git 历史、证据和独立审计锚定仍是事实来源；索引不决定门禁是否通过，也不接管身份或业务写入。

## 配置

原单项目命令保持可用；没有 `--index` 时使用内存 SQLite，既不读取 Postgres 连接环境变量，也不创建数据库连接。单项目可继续使用 `--db <SQLite文件>`；多项目默认每个仓库独立内存 SQLite，不能传 `--db`。

启用 Postgres 时，管理员创建独立索引配置 `index.json`：

```json
{"backend":"postgres","connectionStringEnv":"SPECFORGE_INDEX_URL"}
```

在启动服务的进程环境中设置 `SPECFORGE_INDEX_URL`。连接串、密码和令牌不得写进配置、命令行参数或仓库；驱动异常会转换为通用错误，不输出原文。生产环境的 TLS / CA 和数据库访问策略由数据库与部署管理员配置，驱动沿用 `pg` 的连接选项。

```bash
node apps/server/src/main.ts --projects /srv/specforge/projects.json --index /srv/specforge/index.json
```

多项目使用项目登记中的稳定 ID；配置不得另设 `projectId`。单项目必须显式配置稳定 ID，避免不同仓库共用默认命名空间：

```json
{"backend":"postgres","connectionStringEnv":"SPECFORGE_INDEX_URL","projectId":"demo"}
```

```bash
node /path/to/specforge/apps/server/src/main.ts --index /srv/specforge/index.json
```

`--index` 与 `--db` 互斥；SQLite 的显式配置为 `{"backend":"sqlite"}`。不接受内联连接串或其他配置字段。CLI 不依赖数据库，依旧直接操作项目文件。

## Schema 与事务

- 当前仅支持 `specforge_index` schema v1。首次连接在事务中取得专用 advisory lock、创建 schema 和表并检查版本；需要该专用数据库的连接、schema 创建及表读写权限。新版本服务遇到未知版本会失败，不猜测升级或自动降级。
- 表 `projects` 保存仓库绑定、项目游标与初始化标记；`changes` 主键 `(project_id,id)`，`questions` 主键 `(project_id,change_id,id)`，`events` 主键 `(project_id,seq)`。所有查询都包含项目 ID；已有事件 JSON 与哈希保持原样，不向哈希内容追加字段。
- `projects` 的行锁和项目事务覆盖事件追加、change / question 更新及游标提交；重建只删除本项目的索引行，不删除项目登记或其他项目。源文件读取仍在仓库租约内，SQL 等待期间保持仓库锁；请求可能返回 `409 write_busy`，不自动排队或重放写入。
- 项目 ID 绑定真实目录和 Git 元数据身份，避免改配置后将旧 ID 悄悄换绑另一仓库。同一服务器进程重启会验证绑定并全量重建；切换机器、恢复仓库或有意换绑时，停服务并核对源仓库及可信锚定后，由管理员在专用索引库中清理对应项目的索引行与登记，再重新接入，或使用全新的空索引库。不要通过改业务事件绕过绑定。
- 启动时总是从文件重建。运行时按序号追加，仅更新受影响的 change；日志尾哈希不符或截断时项目级重建。索引重建不代表审计校验通过；`sf log verify --anchor <可信SHA>` 与独立备份继续必需。

未来 schema 变更必须提供显式升级说明；v1 没有从旧 Postgres 版本升级的步骤。SQLite 的历史索引无需做数据库迁移，直接从权威文件重建。

## SQLite → Postgres → SQLite

1. 停止该服务；备份项目仓库、`.specforge/`、证据及独立审计分支 / 可信 SHA。用 `sf log verify` 核对源状态；业务文件有损坏时先按恢复说明处理。
2. 准备专用 Postgres 索引库和进程环境，配置 `--index`；保持项目登记 ID 和仓库路径不变，不读取旧 SQLite 文件。
3. 启动服务。逐项目完成 schema / 绑定检查和文件全量重建后才提供查询。登录后检查 `/p/<id>/api/index`（单项目 `/api/index`），应为 `backend=postgres,state=ready`，游标与源事件序号一致；核对列表、问题、事件和可信锚定。
4. 回退时停服务，移除 `--index` 或使用 SQLite 配置，再启动以文件全量重建。不从 Postgres 反写权威文件，也不重新执行此前已经成功的业务操作。旧 Postgres 索引可按管理员保留策略离线删除。
5. 再次比较源文件、事件哈希及 Git 锚定，应完全一致。索引备份不能替代仓库和证据备份。

## 失败状态

已鉴权的 `/api/index` 返回 `backend`、`state`、`lastSyncedSeq`。`ready` 表示最近一次同步成功；`stale` 表示此前成功但后续查询或同步失败；`unavailable` 表示尚未成功同步或已关闭。该端点会主动尝试同步，失败返回 503，游标仍是最后成功提交的值。

显式选择 Postgres 后，连接 / schema / 同步失败不会回退 SQLite，也不会返回空列表冒充成功或继续展示旧列表。运行中的 API 失败为 `503 index_unavailable`（schema / 绑定错误有独立错误码）；定时同步失败会关闭项目订阅，其他健康项目继续运行。数据库恢复后轮询或下一次请求重新同步索引，浏览器需重新连接订阅。仅重试可重建的索引同步，不重试业务写操作。

业务请求在执行文件操作前同步索引。文件写入成功即返回该操作结果；其后索引暂时落后，由下一次同步补齐。客户端若遇网络中断，应核对源事件，不能仅凭索引失败重新提交同一操作。没有文件 / 数据库的分布式事务承诺。

启动时失败的项目仅挂载通用 `503 project_unavailable`，不泄露路径；修复后需重启。单项目启动失败直接退出。schema 创建、连接获取和语句设置了超时，关闭服务会等待已有轮询结束再关闭连接池。

## 验证命令与当前边界

`npm test` 默认只使用 SQLite、注入 SQL 传输与故障客户端；不会连接真实数据库。注入传输覆盖共有 SQL 的参数、过滤与事务语义，不验证 Postgres 的网络、锁或真实 SQL 兼容性。

真实数据库契约命令独立于默认测试，必须由管理员授权专用测试库后显式运行：

```bash
npm run test:postgres
```

该命令只读取 `SF_POSTGRES_TEST_URL`，不读取 `DATABASE_URL`；创建随机前缀的项目登记，结束后清理本轮登记与索引行，保留 schema。测试库必须允许创建 `specforge_index`，不得使用生产库。需要 Postgres 15 或更新版本；当前实测 PostgreSQL 17.4。契约覆盖首次 / 增量 / 空同步、过滤与分页、同名数据隔离、日志截断 / 重写、重建回滚以及迁移前后源文件 / 哈希 / 锚定不变。

2026-11-16 已在用户授权的独立临时容器上完成 PostgreSQL 17.4 真实契约 5/5（Docker 27.3.1，Debian x86_64 Linux）。T4.3e 已完成；T4.3f 继续断库 / schema 权限故障、完整服务迁移回退及 Postgres 多项目浏览器验收，整体尚未标记完成。
