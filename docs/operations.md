# 重大通知存档 MVP 运维说明

本文描述当前 worktree 的实际实现。它不包含任何 secret 值，也不应把本地测试通过解释为生产补抓完成。

## 1. 资源与配置

`wrangler.jsonc` 当前绑定：

| 用途 | 配置 |
| --- | --- |
| Worker | `name: cqu-feed`，`main: worker/index.mjs` |
| 静态资源 | `dist/`，binding `ASSETS`，SPA fallback，Worker 优先 |
| D1 | binding `DB`，database `cqu-feed-mvp` |
| R2 | binding `ARCHIVE`，bucket `cqu-feed-archive` |
| Workers AI | binding `AI` |
| Auth | service binding `AUTH`，服务 `cqu-moe-auth` |
| Workflow | binding `INGEST`，class `FeedIngest`；binding `PDF_OCR`，class `PdfOcrWorkflow` |
| Workflow | binding `CAPTURE`，class `CaptureWorkflow`，执行单篇采集任务 |
| Queue | producer binding `FEED_JOBS`，队列 `feed-jobs`；consumer 指向 `feed-jobs-dlq` |
| Cron | `0 0 * * *` 为每日采集；`*/5 * * * *` 在 runtime 开启时恢复任务/outbox |

非敏感变量：

| 变量 | 当前值 | 作用 |
| --- | --- | --- |
| `BASE_URL` | `https://feed.cqu.moe` | OAuth 回调、桥接 URL 和安全 Origin 判断 |
| `AUTH_BASE_URL` | `https://auth.cqu.moe` | OAuth/JWKS/userinfo/introspection 基础地址 |
| `MAX_FIRECRAWL_PER_DAY` | `120` | D1 全局硬额度，按自然日计数 |
| `MAX_OCR_PER_DAY` | `100` | D1 全局硬额度，按自然日计数 |
| `MAX_ARTICLES_PER_RUN` | `40` | 每个来源 Workflow 每次运行最多处理的通知数 |
| `CRAWL_ENABLED` | `true` | 设为非 `true` 禁止每日和手动启动采集 |
| `SOURCE_MANAGEMENT_ENABLED` | `false` | T04 动态站点/栏目、样本验证与发现调度；需先应用 0006 迁移并绑定 DISCOVERY |
| `TASK_RUNTIME_ENABLED` | `false` | T03 单篇任务入口默认关闭；POST 需它与 `CRAWL_ENABLED` 同时为 `true`，状态 GET 不受此开关影响 |
| `MAX_TASK_ATTEMPTS` | `3` | 自动恢复的 429 等暂态失败最大尝试次数；配置会限制在 1–10 |
| `PDF_OCR_ENABLED` | `true` | 自动入队与每日补偿；不禁止显式 admin 对比任务 |
| `PDF_OCR_MODEL` | `mistral-ocr-4-1` | 固定文档 OCR 模型 |
| `MAX_PDF_OCR_PAGES_PER_DAY` | `50` | UTC 每日预留源 PDF 页数 |
| `MAX_PDF_OCR_PAGES_PER_MONTH` | `1000` | UTC 每月预留源 PDF 页数 |

`MAX_UPLOAD_BYTES_PER_DAY` 未写入 `wrangler.jsonc` 时使用代码默认值 268,435,456 字节，即 256 MiB。它只限制 Firecrawl 页面通过 `/internal/upload` 桥接上传的附件字节，不限制 Worker 直接 `put` 的正文、快照、截图、manifest 等对象。

Workers secrets：

| Secret | 用途 |
| --- | --- |
| `FIRECRAWL_API_KEY` | 已确认生产 Worker 存在同名 Secret；未读取值，真实付费调用有效性待隔离验收。未配置时回退 keyless 入口 |
| `BRIDGE_SECRET` | 给 Firecrawl 页面签发 5 分钟源站 origin 绑定 HMAC capability |
| `MISTRAL_API_KEY` | 私有 R2 正文 PDF 的 Mistral OCR；与验证码 Workers AI 分开计费 |
| `ADMIN_TOKEN` | `/internal/*` 管理 Bearer token |
| `FEED_AUTH_CLIENT_ID` | auth.cqu.moe 机密 OAuth client ID |
| `FEED_AUTH_CLIENT_SECRET` | auth.cqu.moe 机密 OAuth client secret |
| `FEED_SESSION_ENCRYPTION_KEY` | 加密 OAuth transaction 和 BFF 会话 payload |

配置命令：

```sh
pnpm exec wrangler secret put MISTRAL_API_KEY --name cqu-feed
pnpm exec wrangler secret put FIRECRAWL_API_KEY --name cqu-feed
pnpm exec wrangler secret put BRIDGE_SECRET --name cqu-feed
pnpm exec wrangler secret put ADMIN_TOKEN --name cqu-feed
pnpm exec wrangler secret put FEED_AUTH_CLIENT_ID --name cqu-feed
pnpm exec wrangler secret put FEED_AUTH_CLIENT_SECRET --name cqu-feed
pnpm exec wrangler secret put FEED_SESSION_ENCRYPTION_KEY --name cqu-feed
```

不要把 `.private/production-secrets.json` 提交到仓库，也不要在文档、日志或终端回显中复制其内容。

### Firecrawl 付费密钥配置

当前生产 Worker 的密钥名固定为 `FIRECRAWL_API_KEY`。在已安装项目依赖的检出中执行：

```sh
pnpm exec wrangler secret put FIRECRAWL_API_KEY --name cqu-feed
```

仅在 Wrangler 的交互提示中粘贴密钥；不要放进命令参数、聊天、`wrangler.jsonc` 或 Git。也可在 Cloudflare 的 `cqu-feed` → Settings → Variables and Secrets 中添加同名 **Secret**。该密钥用于运行时，不是 Workers Builds 的构建变量。

验证时只列名称：

```sh
pnpm exec wrangler secret list --name cqu-feed
```

看到名称只能证明配置存在，真实抓取与付费额度需要在验收时单独验证。正式版隔离验收 Worker 的 secrets 不会自动继承生产配置；待隔离资源确定后，对该 Worker 单独执行同一配置步骤。不要为配置密钥运行 `pnpm deploy`，它还会执行远程数据库迁移。


## 2. Auth 与访问控制

Feed 使用机密 OAuth client + Feed BFF 会话：

- `GET /auth/login` 发起 PKCE、state、nonce 和浏览器绑定 OAuth 登录。
- `GET /auth/callback` 校验 EdDSA ID token、issuer、audience、nonce 和 userinfo subject。
- `POST /auth/logout` 删除 Feed BFF 会话，不撤销 auth.cqu.moe 中央登录。
- Cookie 为 host-only `__Host-feed_session` 与 `__Host-feed_login`，`Secure; HttpOnly; SameSite=Lax`。
- D1 只保存 cookie/state/token 的 SHA-256 哈希；access/refresh token 和 OAuth transaction 使用 AES-GCM 加密。
- 会话绝对有效期 7 天，并用 `revision`/`refresh_until` 限制并发 refresh。
- 每次受保护请求都会实时 introspection，并要求 `caps.feed.access === true`。

Auth 侧需要存在 `feed.access` 能力。OAuth client 回调必须是：

```text
https://<feed-origin>/auth/callback
```

当前 `<feed-origin>` 来自 `BASE_URL`。如果以后接入自定义域名，必须同时更新：

1. Worker `BASE_URL`；
2. auth.cqu.moe OAuth client redirect URI；
3. 桥接页面可访问的公开 HTTPS origin。

`GET /internal/auth-check` 使用无效 token 调 Auth introspection。预期结果是 Auth 返回 200 且 `active:false`；这只验证 client 凭据与 Auth 通路，不代表真实用户登录成功。

## 3. D1 迁移

迁移目录是 `migrations/`：

- `0001_feed.sql`：来源、通知、附件、运行记录、额度、OCR slot，以及 FTS5 表和同步触发器。
- `0002_auth.sql`：删除未使用原型表，创建 OAuth login transaction 和 BFF session 表。
- `0003_collection_lease.sql`：给通知增加采集 lease，避免手动和每日任务重复扣外部额度。
- `0004_pdf_ocr.sql`：文档 OCR jobs、calls、原子预算、usage 和阅读派生字段。
- `0005_task_runtime.sql`：任务、attempt 账本、outbox、文章 capture fence，以及后续 T04/T06 使用的任务 kind 和三个 topic 枚举。
- `0006_sources.sql`：动态站点/栏目、验证状态与发现 journal。
- `0007_archive_versions.sql`：不可变通知版本与物理对象引用。
- `0009_subscriptions.sql`：个人订阅配置、目标区间和 RSS 凭证。
- `0010_subscription_editing.sql`：订阅版本、删除时的栏目快照、编辑命令回执、所有者偏好版本和恢复额度原子计数。

远程迁移：

```sh
pnpm exec wrangler d1 migrations list cqu-feed-mvp --remote
pnpm exec wrangler d1 migrations apply cqu-feed-mvp --remote
```

本地迁移：

```sh
pnpm exec wrangler d1 migrations list cqu-feed-mvp --local
pnpm exec wrangler d1 migrations apply cqu-feed-mvp --local
```

`pnpm deploy:ci` 和 `pnpm deploy` 都会先应用远程迁移，再部署 Worker。部署失败时先查看迁移和部署各自的日志；已成功应用的 D1 迁移不会随 Worker 回滚。

## 4. T03 单篇采集任务运行时

T03 使用 `tasks`、`task_attempts` 和 `outbox` 保存单篇采集意图、每次 Workflow 交接和启动消息。Queue payload 只包含 `v/type/outboxId/taskId/attempt`；来源与文章 URL 始终从 D1 权威上下文读取，不接受消息或管理请求中的任意 URL。

上线前置条件：

1. 先在目标 D1 应用 `0005_task_runtime.sql`，确认 `tasks/task_attempts/outbox` 和 `articles.capture_fence` 存在。
2. 显式创建 `feed-jobs` 与 `feed-jobs-dlq`，不要复用或改名历史 `rss-*` 资源。
3. 确认 Worker 具有 `FEED_JOBS` producer/consumer 与 `CAPTURE` Workflow binding。
4. 显式把 `TASK_RUNTIME_ENABLED` 与 `CRAWL_ENABLED` 配置为 `true` 后再部署。默认 `TASK_RUNTIME_ENABLED=false`，保证既有 MVP 行为不受新管理提交入口影响。

管理接口均要求 `Authorization: Bearer <ADMIN_TOKEN>`，与阅读端 `feed.access` 会话独立：

| 方法与路径 | 作用 |
| --- | --- |
| `POST /internal/capture-tasks` | 提交 `{articleId,requestId}`；同一 requestId 幂等返回同一 taskId |
| `GET /internal/capture-tasks` | 查看最近任务列表 |
| `GET /internal/capture-tasks/:taskId` | 查看任务、当前 attempt 与文章状态 |
| `POST /internal/capture-tasks/recover` | 手动执行与定时恢复相同的 outbox/attempt 恢复规则 |

浏览器管理入口为 `/admin/tasks`，也可从「采集状态」进入。凭据只在当前页面内存中持有；退出或离开页面后重新输入，不写 URL、localStorage 或日志。提交结果不明时，重试复用原 requestId；明确成功后再次提交代表新的采集意图。

任务状态含义：

- `queued`：任务和启动 outbox 已持久化，等待 Queue。
- `starting`/`running`：指定 Workflow instance 已接手或采集步骤已开始。
- `succeeded`：这次采集已结束并保存结果；文章可能仍为 partial，不能据此认定版本已完整或允许推送。
- `deferred`：429、采集占用等暂态原因等待恢复。
- `blocked`：402/预算耗尽、尝试上限或启动投递耗尽，需要人工处理外部条件。
- `failed`：采集或 Workflow 业务失败。

恢复规则由每 5 分钟 cron 和手动 recover 共用：数据库已提交但 Queue 暂不可用时，outbox 保留并在到期后重发；Queue 已接收但 sent 收据未提交时允许重复发送，消费者按持久任务身份幂等。create 结果未知或记账失败时使用同一 `task-<taskId>-a<attempt>` 实例 ID 查询，不创建随机新实例。只有确认旧实例 terminal 后，到期 deferred 才递增 attempt 并原子写入新 outbox。

Firecrawl 429 保存为 `rate_limited` deferred，默认最多 3 次 attempt；402、预算或额度耗尽保存为 `quota_exhausted` blocked，不按分钟级自动重试。`Archive.capture` 抢占失败返回 skipped 时任务只能延期，不能记成功；这可能表示其他有效采集持有 lease。R2 临时产物允许留下，attachment、article 更新和 task attempt receipt 必须由同一 fence、attempt 和提交时间守卫下的 D1 原子批发布；旧 attempt 或过期 fence 不能污染权威数据。

本地测试使用真实 Miniflare D1/R2/Queue、真实业务采集代码、Firecrawl 外部替身和可控 Workflow 执行适配器。Miniflare Queue broker 是内存态，本地投递和恢复通过不能证明 Cloudflare 队列留存、DLQ、实际 Workflow 持久步骤或生产账号额度行为；这些属于后续隔离云验收。

## 4A. T05 不可变版本读写开关

T05 使用两个默认关闭的独立开关，便于采集写入与阅读切换分批上线：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `ARCHIVE_VERSIONS_ENABLED` | `false` | capture task 保存不可变版本、产物清单和物理对象引用，保留旧 MVP 字段与原件 |
| `ARCHIVE_READS_ENABLED` | `false` | 通知详情与文件读取改走最新 ready 版本；关闭后继续使用旧 MVP 读字段 |

版本 API 均要求 Feed 会话与 `feed.access`：

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/articles/:articleId/revisions` | 返回按版本号倒序的观察时间线 |
| `GET /api/articles/:articleId/revisions/:revisionId` | 返回指定版本详情、产物清单和该版本附件 |
| `GET /api/articles/:articleId/revisions/:revisionId/files/:filename` | 读取该版本原始附件字节，支持 `HEAD` 与 `Range` |
| `GET /api/articles/:articleId/revisions/:revisionId/snapshot` | 读取绑定该版本的原貌存档 |
| `GET /api/articles/:articleId/revisions/:revisionId/screenshot` | 读取该版本可选截图 |

阅读端 `/api/articles/:articleId` 只选择最新 ready 版本。`assembling` 或 `blocked` 版本可查看观察时间、状态和缺项原因，但正文为空、附件没有链接，不能顶替已有完整阅读。版本编号在采集租约下预留，失败重试可能形成编号空隙；A→B→A 是三次独立观察，第三次可复用 A 的物理对象。同名附件内容变化时，两个版本继续保留各自原始字节。

历史原貌中的附件链接和 PDF iframe 均改写为上述 revision-bound 路由；阅读器页面为 `/reader/:articleId/revisions/:revisionId/:filename`。原貌 CSP 仍禁止源站脚本、表单提交和未知 frame。T05 本地 Miniflare 测试覆盖 A→B→A、同名附件字节变化、同任务重放、缺项版本保留旧阅读、PDF-only 正文原件不可用时的 blocked 观察、R2 成功后 D1 失败重试、过期 fence、历史原貌改写和未登录拒绝。真实云端与账号验收仍留在 T17。

PDF-only 缺失原件时保留 blocked 观察，列表明确显示缺项，待确认完整后才开放阅读。文件抓取时间按实际下载记录保存；未记录的时间保持未知，不用其他文件的时间冒充。

## 4B. T06 正文 OCR 与完整版本发布

应用 `0008_content_events.sql` 后，正式版增加 `ARCHIVE_OCR` Workflow、`FEED_EVENTS` Queue 及其 DLQ。采集只保存观察结果与后续 outbox；采集任务成功不代表文章已完整。所有版本统一经 `Archive.reconcileRevision` 检查必需原件与 OCR，确认 R2 对象存在且匹配记录后，在同一 D1 批次提交 ready、内容事件、来源证据、阅读投影、只向前移动的最新完整版本指针和事件 outbox。管理任务详情同时显示版本缺项。

正文 PDF 逐页检查可提取文字；混合 PDF 仅把需识别页发送给 OCR，完整结果仍包含原生文字页。输入文件 hash、处理器版本和选项决定任务与缓存身份。`PDF_OCR_MODEL` 默认 `mistral-ocr-4-1`，`ARCHIVE_OCR_PROCESSOR_VERSION` 默认 `v1`；改变识别规则时显式升级处理器版本。每份 PDF 最多 20 个需 OCR 页，日/月预算按整个输入页数预留。成功响应先保存 R2 派生结果日志，再建立 D1 引用；R2 已保存而 D1 提交失败时，重放复用该日志。

`POST /internal/articles/:articleId/pdf-ocr` 使用当前处理器配置重建当前阅读投影，`GET` 返回对应 OCR 状态。历史完整版本继续使用发布时冻结的结果；重做不新建源版本或内容事件。多份正文 PDF 的结果按文件保存到聚合投影，版本检查避免并发重做覆盖另一份文件的识别改进。新源版本的投影与旧投影分开，HTML 后续版本不会继承旧 PDF 的 OCR。

正文、附件或必要 OCR 未齐备时，不开放该候选版本的正文与文件链接；既有完整版本继续可读。历史补抓/迁移的内容事件带 `history_only`，日期未知的事件保留待核实。当前 `event-ready` 仅完成持久交接校验，订阅匹配与投递由后续任务接入；不能把事件存在等同于已发邮件。本地验证包括实际 Worker Queue/BFF 入口、R2/D1 故障重放、乱序就绪与多 PDF 重做；云平台持久步骤及真实供应商验收仍属于 T17。

## 4B. T07 个人订阅配置

应用 `0009_subscriptions.sql` 后，登录用户可在 `/subscriptions` 命名并创建多个订阅，选择栏目或创建时展开的站点范围，默认每日摘要。当前切片只保存配置，RSS 内容与邮件由后续 T09/T11 开放，界面明确显示这一状态。

`GET /api/subscriptions` 返回当前会话所有者的配置、当前 Auth 配额、计算出的运行状态和可选栏目。`POST /api/subscriptions` 接受 `{requestId,name,siteIds,sourceIds,emailMode}`，校验同源 Origin；不接受客户端指定 owner。所有未删除配置计创建额度，包括暂停、邮件关闭和 RSS 撤销项；条件 INSERT 与目标、请求回执同批提交，防止并发超额。同 requestId 重试返回原订阅和原栏目范围，不因站点新增栏目而扩大。

每个订阅生成 256 bit 随机 RSS token。D1 保存 hash 及 AES-GCM 密文，密文绑定所有者、订阅 ID 和凭证代次，使用区别于 BFF 会话的用途派生密钥。当前密钥材料使用既有 `FEED_SESSION_ENCRYPTION_KEY`（兼容别名 `SESSION_ENCRYPTION_KEY`）；不新增必须配置的 secret。登录后的所有者可持续查看和复制当前链接，刷新或重试不会生成新链接。响应不缓存，token 不写入日志。重置/撤销功能由 T08 接入。

更换上述密钥材料前，应使用旧密钥解密并迁移 RSS 密文，再切换运行时 secret；只更换 secret 会使旧 RSS 链接无法在设置中取回。RSS hash 校验与密文展示分别保留，后续轮换可重建凭证；不能通过静默重置链接掩盖密钥丢失。

界面区分零/缺失额度、权限撤回、超额和 Auth 暂不可用；已保存配置保留。创建后发生降额或 Auth 查询故障，返回 `created` 与当前暂停原因；响应丢失时按同 requestId 重试，不断言保存失败。保存期间锁定表单，避免旧响应覆盖新草稿。

## 4C. T08 订阅编辑与运行集合

应用 `0010_subscription_editing.sql` 后，登录所有者可以编辑订阅名称、栏目、邮件模式、启用状态和优先级，也可以软删除、恢复、轮换或撤销 RSS 链接。除创建和恢复外，这些收窄或重排操作不重新消耗创建额度，也不因当前已超额、撤权或 Auth 暂不可用而丢失配置。

写接口均要求同源 Origin 与当前会话，且不接受客户端指定 owner：

| 方法与路径 | 作用 |
| --- | --- |
| `PATCH /api/subscriptions/:id` | 全量更新名称、栏目、邮件模式、启用意愿和优先级 |
| `DELETE /api/subscriptions/:id` | 软删除配置，撤销当前 RSS 并关闭当前目标区间 |
| `POST /api/subscriptions/:id/restore` | 重新检查 access 与创建额度后恢复配置 |
| `POST /api/subscriptions/:id/rss/rotate` | 仅替换该订阅的 RSS 凭证 |
| `POST /api/subscriptions/:id/rss/revoke` | 仅撤销该订阅的当前 RSS 凭证 |

编辑、删除、恢复和 RSS 命令都携带 `{requestId,expectedVersion}`；恢复和编辑还携带完整配置。D1 在同一原子批中写入命令回执、主配置和派生目标区间，所有派生写同时要求本命令回执、命令 hash 和版本条件匹配。并发编辑只有一个命令能从 expected 版本推进，失败方不留下目标区间或偏好副作用；同 requestId 重放返回 `changed:false`，版本或内容冲突返回 409。恢复先用 `feed_accounts.active_subscription_count` 和本次请求预约做原子额度 CAS；并发恢复只允许限额内数量成功，失败回执会被清理，额度释放后可用原 requestId 重试。

目标区间保留历史：移除后再次加入会生成新的 `effective_from`，不会沿用原创建时间。区间身份取自保存请求，连续命令即使时间相同也保持独立。删除时在同一事务保存当时的栏目清单，恢复表单从这份快照预填，不用删除时间推算栏目。管理员停用或验证失效后，已选栏目可以继续保留在编辑请求中，重命名、关闭邮件、暂停、删除或缩小范围不受阻；只有新增目标才要求当前站点、栏目启用且验证通过。恢复删除同样生成新的目标生效时间，不复活旧区间。

运行集合由 `worker/subscription-runtime.mjs` 统一计算：未删除且用户希望启用的配置按 `(priority,created_at,id)` 排序，在限额内输出；暂停、邮件关闭和 RSS 撤销仍计创建数量，软删除不计。配额下降只把超额项标为 `quota_exceeded`，不删除配置或 RSS 身份；配额恢复不会打开用户主动关闭的订阅。列表的 `usage` 只计未删除配置，已删除配置仍返回给所有者以便恢复，状态为 `deleted`。

每个订阅的 `effectiveStatus` 表示整体权益/额度/启用状态，`rssStatus` 单独区分 `rss_revoked`，`emailStatus` 单独区分 `mail_off` 与 `email_unverified`。邮箱未验证不影响 RSS 配置；Auth 暂不可用时已保存配置保持可管理并显示 `auth_unavailable`。RSS 内容与邮件投递仍未开放，等待 T09/T11 接入实际输出。

RSS 轮换生成新 token 与新代次密文，AAD 继续绑定所有者、订阅 ID 和代次；旧 hash 被原子替换，撤销将 `rssUrl` 置空。轮换和撤销不改变创建数量，也不写 token 到日志。密文仍复用 `FEED_SESSION_ENCRYPTION_KEY`（兼容别名 `SESSION_ENCRYPTION_KEY`）；更换密钥前必须先按 T07 说明迁移旧密文，再切换 secret。迁移后可要求所有者逐项轮换，不能用静默重置掩盖密文不可解。

## 5. 构建与部署

日常部署通过 push 到 main 触发 Cloudflare Git Connector；GitHub Actions 只运行检查。构建命令、部署命令和环境配置见 [ci-cd.md](ci-cd.md)。Cloudflare 执行 `pnpm run ci` 后，再执行 `pnpm deploy:ci`。

本地检查及必要时的手动部署：

```sh
pnpm install --frozen-lockfile
pnpm run ci
pnpm deploy
```

`pnpm deploy` 的实际内容是：

```sh
pnpm build && pnpm deploy:ci
# deploy:ci: wrangler d1 migrations apply cqu-feed-mvp --remote && wrangler deploy
```

部署后做只读检查：

```sh
curl https://feed.cqu.moe/health
FEED_URL=https://feed.cqu.moe \
FEED_ADMIN_TOKEN='<redacted>' \
node scripts/manage.mjs auth-check
```

不要把真实 token 替换进文档或提交记录。真实账号登录、搜索和存档验证见 `acceptance.md`。权益撤销通过隔离集成测试验证，不会为测试撤销生产账号权益。

## 6. 采集 Workflow

Cron 每天采集的 5 个来源来自 `worker/sources.json`：

| ID | 名称 | 列表入口 |
| --- | --- | --- |
| `jwc` | 教务处 | `/index/tzgg.htm`、`/index/tzgg/xjgl.htm` |
| `intex` | 国际处 | `/index/tzgg.htm` |
| `civil` | 土木学院 | `/xzwb/tzgg.htm` |
| `xgb` | 学工部 | `/list.jsp?urltype=tree.TreeTempUrl&wbtreeid=1024` |
| `news` | 新闻网 | `/tzggjb.htm` |

这些路径均相对于各自站点 origin；正文链接必须匹配对应 `articlePattern` 且保持同源。

Cron 每天为 5 个来源各创建一个 `FeedIngest` 实例：

1. `start`：upsert 来源、创建 run，并把过期 `collecting` 状态恢复为 failed/partial。
2. `discover-*`：Firecrawl 抓列表，最多 12 页；解析同源、匹配 article pattern 且日期在 30 天窗口内的链接。
3. `pending`：选出 `pending`、`partial`、`failed` 且 `attempts<3` 的通知，每来源最多 40 篇。
4. `article-*`：用 D1 lease 抢占通知，调用 Firecrawl 抓正文和附件，写 R2/D1。
5. 每篇间隔 2 秒；额度、429、402、quota、credit 类错误会停止当前来源后续文章。
6. `finish`：写 run 状态、来源最近运行时间和错误摘要，并清理超过 1 天的 OCR slot。

初始 30 天窗口按每个 Workflow 创建时的 `cutoff` 计算。日期缺失的列表条目不会入队；这是为了防止把旧通知误收进 30 天窗口，代价是站点结构变化时会记录“无可靠日期”而不是补齐。

### Firecrawl 页面动作

正文采集发生在 Firecrawl 的源站云页面中：

- 识别常见正文容器，提取 `bodyText`。
- 扫描附件链接、iframe、embed、object。
- 附件下载保持在源站 origin，并使用原浏览器会话。
- 每篇最多处理 8 个附件，总下载动作时间约 165 秒。
- 单附件最大 64 MiB；小于等于 2 MiB 的文件随页面动作返回，大于 2 MiB 的文件经临时 Worker 桥接流式上传 R2。
- 四位数字 CAPTCHA 最多尝试 2 次。验证码图片和识别结果经 5 分钟 HMAC capability 关联到具体 run、文章和源站 origin。
- Worker 校验文件名、长度、magic bytes、Origin 和每日上传字节，R2 写入后用 SHA-256 manifest 读回验证。

### 存档产物

每篇文章保存在：

```text
articles/{articleId}/{runId}/
```

典型对象包括：

- `body.txt`、`body.md`、`rendered.html`
- `snapshot.html`、`offline.html`
- `original.png`
- `attachment-1.pdf`、`attachment-2.docx` 等
- `attachment-N.pdf.txt`（正文型 PDF 文字层；早期记录为 `.md`）
- `manifest.json`

R2 桶不公共开放。所有读取都由 Worker 查 D1 后代理，响应为 `private, no-store`，附件支持 `Range`、`HEAD`、ETag/If-Range 和 416。

## 7. 搜索与索引

D1 FTS5 表：

```sql
CREATE VIRTUAL TABLE article_search USING fts5(
  id UNINDEXED,
  title,
  body_text,
  tokenize='trigram'
);
```

插入、更新标题/正文、删除通知时由触发器同步索引。

可搜索内容：

- 通知标题；
- 页面正文文本；
- Firecrawl Markdown 正文；
- 正文 PDF 的 unpdf 文字层及成功发布的 Mistral 扫描件 OCR 文本。

不索引：

- 普通 `.doc/.docx/.xls/.xlsx/.ppt/.pptx` 附件内容；
- ZIP/RAR/7Z 内容；
- 附件二进制元数据；
- 未保存成功的附件；
- 快照 HTML 本身。

因此“附件已保存”不代表“附件全文可搜索”。如果正文型 PDF 转换失败，文章会保留原 PDF 和错误信息，状态为 partial，正文搜索不包含该 PDF 文本。

## 8. 管理命令

现有脚本：

```sh
FEED_URL=https://feed.cqu.moe \
FEED_ADMIN_TOKEN='<redacted>' \
node scripts/manage.mjs status

FEED_URL=https://feed.cqu.moe \
FEED_ADMIN_TOKEN='<redacted>' \
node scripts/manage.mjs run

FEED_URL=https://feed.cqu.moe \
FEED_ADMIN_TOKEN='<redacted>' \
node scripts/manage.mjs auth-check
```

- `status`：最近 20 个 run、按来源/状态聚合的文章数、最近 20 条每日用量。
- `run`：手动创建 5 个来源 Workflow；仍受 `CRAWL_ENABLED`、lease、attempts 和全局额度限制。
- `auth-check`：验证 OAuth client 与 Auth introspection 通路。
- `capture-tasks`：T03 管理 HTTP 入口见上一节；单篇恢复使用同一个 `recover` 接口，不重跑整站。

优先通过 `FEED_ADMIN_TOKEN` 环境变量传值。未设置该变量时，脚本会尝试读取 `.private/production-secrets.json`；不要把该文件提交、打包或输出到日志。

首次补抓快照记录在 `acceptance.md`。后续运行以 `/internal/status` 和 D1/R2 读回为准。`complete` 仅表示已发现候选的存档完整，不承诺发现站点所有历史栏目或为扫描文件完成 OCR。

## 9. 额度、成本与失效行为

| 边界 | 当前值 | 失效行为 |
| --- | --- | --- |
| Firecrawl 全局每日请求 | 120 | 后续请求抛 budget 错；当前来源停止处理后续文章 |
| OCR 全局每日次数 | 100 | 该验证码尝试失败，文章/附件状态记录错误 |
| 每来源每次运行处理通知 | 40 | 未处理通知保持待处理，等待后续运行 |
| 列表页数 | 每来源 12 页 | run 标记 pagination limit，discovery incomplete |
| 文章内容错误尝试次数 | 3 | 之后人工排查；全局额度/限流延期不消耗次数 |
| 附件数量 | 每篇 8 个 | 超出的候选附件不下载，记为 attachment limit reached |
| 附件大小 | 64 MiB | 拒绝下载/上传 |
| 桥接附件上传 | 默认每日 256 MiB | 返回 429，相关附件失败 |
| 页面动作内嵌产物 | 8 MiB | 超 2 MiB 的附件改走桥接；其他 artifact 超限失败 |
| Worker 直接写 R2 artifact | 12 MiB | 对应产物失败，文章可能 partial |
| Firecrawl HTTP 响应 | 40 MiB | 请求失败 |

额度在 D1 `usage(day, kind, used)` 中按自然日保留。Firecrawl 和 OCR 在发起外部调用前先占用额度，因此外部调用失败通常也会消耗一次。桥接上传额度在验证请求后、R2 完成前增加，流式上传中途失败也可能消耗字节额度。

初始 30 天补抓的上限之间存在明显张力：5 个来源理论上每次最多 40 篇正文，再加列表页请求，可能超过全局 Firecrawl 120 次/天。因此补抓天然可能跨多天，且 5 个来源并发竞争同一个额度。不能把单日 `partial` 直接当作站点不可用；应同时查看 run error、usage 和下一日重试结果。

Workers AI、R2 PUT、R2 存储、D1 行数和 Workers CPU 都会产生费用或免费额度消耗。D1 的 Firecrawl/OCR/上传额度不约束快照、正文、截图、manifest 和小附件写入，也不约束用户读取流量。扩大站点、历史窗口或放开附件前必须重新估算并调整这些上限。

## 10. 安全模型

- SPA HTML 使用 CSP 限制脚本、连接、frame、object、base 和 form，主题初始化脚本以 SHA-256 hash 允许。
- 所有 `/api/*` 内容出口先经过 Feed BFF session 和 Auth introspection。
- 未登录返回 401；已登录但缺 `feed.access` 返回 403；Auth/DB 故障 fail closed 返回 503。
- R2 不直接暴露；附件、截图、快照全部经 Worker 查 D1 后读取。
- 文件响应带 `private, no-store`、`nosniff`、ETag 和 `Accept-Ranges`。
- 原貌 HTML 用 `HTMLRewriter` 删除 script、base、meta、object、embed、applet、preload/prefetch、事件属性、`srcdoc`、`ping`、`formaction` 等活动内容。
- 快照 CSP 为 `default-src 'none'; script-src 'none'`，仅允许 data 样式/图片/字体和 self frame；源站脚本与网络请求不可执行。
- form 只移除标签外壳，保留包裹的文章内容；CSP 禁止提交。只有 D1 中已保存的 PDF 文件名会被写回 iframe，移除 SingleFile 的 PDF sandbox 以嵌入自托管 PDF.js 阅读器；未知 frame 被删除。
- 快照内附件链接改写为 Feed 受保护下载路由，并移除源站 `onclick`/`target`。
- Worker 日志会清理 URL 和 Bearer token，并截断错误文本。

## 11. 验证与派生文本维护

验收记录见 [acceptance.md](acceptance.md)，区分本地测试、真实账号业务验证和云端对象完整性。

清理已保存正文中的阅读器提示、PDF 元数据和网页导航，不重新调用 Firecrawl：

```sh
node scripts/clean-reading.mjs --remote
node scripts/clean-reading.mjs --remote --apply
```

第一条只预览。第二条先把原始派生文本备份到忽略的 `.private/`，再用 content hash 条件更新 D1；FTS 触发器自动同步索引。R2 原始产物和 manifest 保持不变。后续新采集会直接保存清理后的 `body.txt`。

正文 PDF 使用 unpdf 的 serverless PDF.js 在 Worker 内提取文字层，最大 12 MiB / 100 页，无额外转换服务调用。有文字层但被第三方转换器遗漏的历史文件，可执行 `node scripts/manage.mjs repair-text <article-id>`：在云端读取 R2，写入独立 `reading-v2.txt` 和派生 manifest，再更新 D1/FTS。没有文字层的正文扫描件自动进入独立 PdfOcrWorkflow；失败、超限、预算不足时保留原件和原正文。详见 [OCR 实现](pdf-ocr-design.md)。

PDF.js 阅读页为 `/reader/{articleId}/{filename}`，仍先验证 Feed 会话，再从受保护文件路由读取 R2。React-PDF/PDF.js 版本严格配对；构建脚本 `copy-pdf-assets.mjs` 复制 CMaps、字体、WASM 和许可证到静态资源，不依赖 CDN。阅读器单独懒加载；只有该页面的 CSP 允许同源 frame-ancestors 和 wasm-unsafe-eval，脚本字符串 eval 仍禁用。

## 12. 文档 OCR 运维

对已归档样片执行：

```sh
node scripts/compare-ocr.mjs status
node scripts/compare-ocr.mjs results mistral-ocr-4-1
node scripts/compare-ocr.mjs publish mistral-ocr-4-1
```

已完成结果 publish 只更新阅读与索引，不再收费识别。start 可能发起付费调用，仍受文件缓存和全局页数预算约束。任意其他 article 通过带 ADMIN_TOKEN 的 `/internal/pdf-ocr/<id>` 管理。

查看 D1 `pdf_ocr_jobs` 了解失败和延期；`pdf_ocr_usage` 是按日/月的预留/成功处理页数与估算费用，`pdf_ocr_budget` 是原子配额状态。超时可能已经收费，因此失败不释放预算，不要为恢复任务随意清除 calls/attempts。`PDF_OCR_ENABLED=false` 只停止新自动入队，已启动 Workflow 仍可完成；不清空 key、数据或已发布文字。

当前只对 body-pdf 自动 OCR。最大 12 MiB/100 个源页/20 个 OCR 页，按每次请求完整源页数保守预留预算。每月 1000 页对应默认模型约 $4 基础 OCR 用量，Cloudflare 和整个供应商账号的总账单不受这个应用额度封顶。


## 正式版多来源接入（T04，默认关闭）

先应用 `0006_sources.sql`，在独立环境绑定 `DISCOVERY` → `DiscoveryWorkflow`，并启用 `SOURCE_MANAGEMENT_ENABLED`、`TASK_RUNTIME_ENABLED` 与 `CRAWL_ENABLED`。不要在未完成隔离验收前修改生产开关。旧 MVP 的五个来源沿用原 ID；新站点和栏目保存在 D1，动态开关关闭时仍使用旧来源清单。

管理入口 `/admin/sources` 使用既有管理员凭据；保存站点后创建栏目草稿。配置包含同站 HTTPS 列表 URL、文章路径正则、含附件的通知样本、刷新间隔（1800–604800 秒）与 IANA 时区。修改抓取配置须先暂停栏目；版本递增后要重新验证。暂停站点或栏目只停止新增调度，已有存档仍可阅读。

`POST /internal/sites` 接收 `{name, origin, requestId}`；`requestId` 为 8–100 个 URI-safe 字符，同请求同内容重试返回同一站点，同请求不同内容返回 409。Origin 只约束抓取域，不合并逻辑站点；不同创建请求可以建立同 Origin 的独立站点。栏目身份按站点与列表 URL 确定，通知身份仍按 canonical URL 跨栏目去重。管理页在内存中保留尚未确认的创建请求，网络失败后原样重试，成功或退出时清理。

样本验证通过 `POST /internal/sources/:id/verify` 提交 `{requestId}`，立即返回 HTTP 202 和持久任务 ID。相同配置版本与 requestId 的重试复用原任务；服务端检查列表、最多一页分页、正文、附件文件签名与原貌快照。无分页的列表明确记录 `paginationMode=absent`。旧配置的验证结果不能批准新配置；验证成功后仍须管理员单独启用。页面会轮询状态，离开页面不取消任务。

每五分钟扫描到期栏目，将配置快照与启动 outbox 同批持久化。一个 DiscoveryWorkflow 处理一页，先将列表原始报告与解析结果保存为任务独占的 R2 日志，再在同一事务中记录来源关联、单篇采集任务、下一页任务与执行回执。每轮默认最多两页（`MAX_DISCOVERY_PAGES_PER_RUN` 可配置 1–10），完整历史补抓由 T14 独立负责。数据库提交前失败会持久延期并复用 R2 日志；提交响应丢失时从回执及 outbox 恢复，已保存页面不重新调用抓取，首次发现时间仍使用原列表结果时间。不同栏目遇到同 canonical URL 时共享通知身份及首次采集任务，但保留各自发现证据；不同 URL 不按标题合并。

`GET /internal/sources/:id/discoveries` 返回该栏目最近 100 条发现证据：首次/最近发现、live/backfill/migrated 分类、日期精度、原站日历日期、准确时间与时区。日级日期不补成零点，未知日期不补成当前日期；明确分钟时间按来源时区转换，夏令时歧义降为日级证据。后续推送仍要经过日期资格与版本完整性检查。

本地验收：真实 Worker 管理及 BFF 阅读入口、Miniflare D1/R2/Queue、外部 Auth 与 Firecrawl Adapter；覆盖异步验证、重复请求、旧配置结果、分页原子恢复、多栏目身份、限流隔离、暂停阅读和日期精度。真实站点样本、云 Queue/Workflow 交接与生产开关验收属于 T17/T18，不能用这些本地结果替代。

## 正式版邮件（T11）

启用前应用 0014 迁移，配置独立 `FEED_MAIL` Queue 与 DLQ、`MAIL_FROM`，并通过 Worker secrets 设置 `RESEND_API_KEY` 和 `RESEND_WEBHOOK_SECRET`。API key 需支持发送和邮件查询；发件域须在 Resend 验证。Webhook 地址为当前环境的 `/webhooks/resend`，使用该 endpoint 自己的签名密钥。不得把密钥写入 Git、请求日志或操作记录。`MAIL_ENABLED` 默认 false，不会因合入代码自动发信。

匹配完成后准备及时邮件；Cron 每五分钟恢复遗漏准备、持久延期、超时提交及已落盘但尚未处理的回调，再分发 outbox。`MAIL_PREPARE_LIMIT` 每轮默认20、上限50，`MAX_MAIL_ATTEMPTS` 默认6、上限10。定时器和 Queue 同时触发也共用 delivery 条件占用。每代 outbox 的投递次数也受同一上限约束；快照读取等提交前故障耗尽 Queue 重试后，不会被 Cron 无限重新入队，而是保留消息与占用、停止自动恢复，显示待人工处理。关闭发送时，保留 webhook 签名密钥仍会继续恢复已落盘回执；该流程不准备或提交新邮件。

管理员 `GET /internal/mail` 查看安全状态；`POST /internal/mail/prepare` 与 `/internal/mail/recover` 复用生产准备/恢复规则。`POST /internal/mail/:id/reconcile` 仅查询已经确认的 provider ID，不发送新邮件；未知 provider ID 不能靠猜测恢复。受理表示服务商接受，delivered 表示收件服务器接受，均不等于读者已阅读。退信/投诉独立抑制邮箱，不关闭订阅或 RSS。

以上是本地实现和配置说明。真实 Queue、供应商与指定邮箱的完整验收仍在 T17；正式开启按 T18 上线方案审批。
