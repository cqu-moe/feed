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
| Workflow | binding `INGEST`，class `FeedIngest` |
| Cron | `0 0 * * *`，UTC 00:00 / 北京时间 08:00 |

非敏感变量：

| 变量 | 当前值 | 作用 |
| --- | --- | --- |
| `BASE_URL` | `https://cqu-feed.user-unauthorized.workers.dev` | OAuth 回调、桥接 URL 和安全 Origin 判断 |
| `AUTH_BASE_URL` | `https://auth.cqu.moe` | OAuth/JWKS/userinfo/introspection 基础地址 |
| `MAX_FIRECRAWL_PER_DAY` | `120` | D1 全局硬额度，按自然日计数 |
| `MAX_OCR_PER_DAY` | `100` | D1 全局硬额度，按自然日计数 |
| `MAX_ARTICLES_PER_RUN` | `40` | 每个来源 Workflow 每次运行最多处理的通知数 |
| `CRAWL_ENABLED` | `true` | 设为非 `true` 禁止每日和手动启动采集 |

`MAX_UPLOAD_BYTES_PER_DAY` 未写入 `wrangler.jsonc` 时使用代码默认值 268,435,456 字节，即 256 MiB。它只限制 Firecrawl 页面通过 `/internal/upload` 桥接上传的附件字节，不限制 Worker 直接 `put` 的正文、快照、截图、manifest 等对象。

Workers secrets：

| Secret | 用途 |
| --- | --- |
| `FIRECRAWL_API_KEY` | 可选；当前未配置，使用 Firecrawl keyless 入口，可能受 IP 限流 |
| `BRIDGE_SECRET` | 给 Firecrawl 页面签发 5 分钟源站 origin 绑定 HMAC capability |
| `ADMIN_TOKEN` | `/internal/*` 管理 Bearer token |
| `FEED_AUTH_CLIENT_ID` | auth.cqu.moe 机密 OAuth client ID |
| `FEED_AUTH_CLIENT_SECRET` | auth.cqu.moe 机密 OAuth client secret |
| `FEED_SESSION_ENCRYPTION_KEY` | 加密 OAuth transaction 和 BFF 会话 payload |

配置命令：

```sh
pnpm exec wrangler secret put FIRECRAWL_API_KEY --name cqu-feed
pnpm exec wrangler secret put BRIDGE_SECRET --name cqu-feed
pnpm exec wrangler secret put ADMIN_TOKEN --name cqu-feed
pnpm exec wrangler secret put FEED_AUTH_CLIENT_ID --name cqu-feed
pnpm exec wrangler secret put FEED_AUTH_CLIENT_SECRET --name cqu-feed
pnpm exec wrangler secret put FEED_SESSION_ENCRYPTION_KEY --name cqu-feed
```

不要把 `.private/production-secrets.json` 提交到仓库，也不要在文档、日志或终端回显中复制其内容。

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

`pnpm deploy` 不会应用迁移。部署新 Worker 代码前必须先确认远程迁移已应用，避免 Worker 查询不存在的表。

## 4. 构建与部署

```sh
pnpm install
pnpm test
pnpm build
pnpm check:design
pnpm exec wrangler d1 migrations apply cqu-feed-mvp --remote
pnpm deploy
```

`pnpm deploy` 的实际内容是：

```sh
pnpm build && wrangler deploy
```

部署后做只读检查：

```sh
curl https://cqu-feed.user-unauthorized.workers.dev/health
FEED_URL=https://cqu-feed.user-unauthorized.workers.dev \
FEED_ADMIN_TOKEN='<redacted>' \
node scripts/manage.mjs auth-check
```

不要把真实 token 替换进文档或提交记录。真实账号登录、搜索和存档验证见 `acceptance.md`。权益撤销通过隔离集成测试验证，不会为测试撤销生产账号权益。

## 5. 采集 Workflow

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

## 6. 搜索与索引

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
- 被识别为正文 PDF、且 unpdf 成功提取的 PDF 文本。

不索引：

- 普通 `.doc/.docx/.xls/.xlsx/.ppt/.pptx` 附件内容；
- ZIP/RAR/7Z 内容；
- 附件二进制元数据；
- 未保存成功的附件；
- 快照 HTML 本身。

因此“附件已保存”不代表“附件全文可搜索”。如果正文型 PDF 转换失败，文章会保留原 PDF 和错误信息，状态为 partial，正文搜索不包含该 PDF 文本。

## 7. 管理命令

现有脚本：

```sh
FEED_URL=https://cqu-feed.user-unauthorized.workers.dev \
FEED_ADMIN_TOKEN='<redacted>' \
node scripts/manage.mjs status

FEED_URL=https://cqu-feed.user-unauthorized.workers.dev \
FEED_ADMIN_TOKEN='<redacted>' \
node scripts/manage.mjs run

FEED_URL=https://cqu-feed.user-unauthorized.workers.dev \
FEED_ADMIN_TOKEN='<redacted>' \
node scripts/manage.mjs auth-check
```

- `status`：最近 20 个 run、按来源/状态聚合的文章数、最近 20 条每日用量。
- `run`：手动创建 5 个来源 Workflow；仍受 `CRAWL_ENABLED`、lease、attempts 和全局额度限制。
- `auth-check`：验证 OAuth client 与 Auth introspection 通路。

优先通过 `FEED_ADMIN_TOKEN` 环境变量传值。未设置该变量时，脚本会尝试读取 `.private/production-secrets.json`；不要把该文件提交、打包或输出到日志。

首次补抓快照记录在 `acceptance.md`。后续运行以 `/internal/status` 和 D1/R2 读回为准。`complete` 仅表示已发现候选的存档完整，不承诺发现站点所有历史栏目或为扫描文件完成 OCR。

## 8. 额度、成本与失效行为

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

## 9. 安全模型

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

## 10. 验证与派生文本维护

验收记录见 [acceptance.md](acceptance.md)，区分本地测试、真实账号业务验证和云端对象完整性。

清理已保存正文中的阅读器提示、PDF 元数据和网页导航，不重新调用 Firecrawl：

```sh
node scripts/clean-reading.mjs --remote
node scripts/clean-reading.mjs --remote --apply
```

第一条只预览。第二条先把原始派生文本备份到忽略的 `.private/`，再用 content hash 条件更新 D1；FTS 触发器自动同步索引。R2 原始产物和 manifest 保持不变。后续新采集会直接保存清理后的 `body.txt`。

正文 PDF 使用 unpdf 的 serverless PDF.js 在 Worker 内提取文字层，最大 12 MiB / 100 页，无额外转换服务调用。有文字层但被第三方转换器遗漏的历史文件，可执行 `node scripts/manage.mjs repair-text <article-id>`：在云端读取 R2，写入独立 `reading-v2.txt` 和派生 manifest，再更新 D1/FTS。没有文字层的扫描件仍需 OCR，阅读器可直接显示原文件。

PDF.js 阅读页为 `/reader/{articleId}/{filename}`，仍先验证 Feed 会话，再从受保护文件路由读取 R2。React-PDF/PDF.js 版本严格配对；构建脚本 `copy-pdf-assets.mjs` 复制 CMaps、字体、WASM 和许可证到静态资源，不依赖 CDN。阅读器单独懒加载；只有该页面的 CSP 允许同源 frame-ancestors 和 wasm-unsafe-eval，脚本字符串 eval 仍禁用。
