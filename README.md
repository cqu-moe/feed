# 重大通知存档（CQU Feed）

重大通知存档是一个运行在 Cloudflare 上的重庆大学通知采集、私有备份、统一阅读和搜索服务。MVP 覆盖教务处、国际处、土木学院、学工部和新闻网 5 个栏目；访问统一走 auth.cqu.moe，并且账号必须拥有 `feed.access` 权益。

已部署到 [Feed](https://feed.cqu.moe/)。2026-10-11 首次补抓已归档 33 篇通知、63 个附件、33 份原貌 HTML 和截图；真实账号已完成登录与中文搜索验证。详细验收与限制见 [docs/acceptance.md](docs/acceptance.md)。

## 功能

- 每日自动发现 5 个站点中最近 30 天内发布的通知。
- 使用 Firecrawl 云页面抓取列表和正文，并在原始源站会话中下载附件。
- 遇到四位数字附件验证码时，通过带时限 HMAC 授权的 Worker 桥接调用 Workers AI OCR，再用源站会话重试下载。
- 将正文、正文型 PDF 文本、原貌 HTML、截图和附件保存到 R2；通知元数据和索引进 D1。
- 扫描正文 PDF 自动进入 TextIn Workflow，仅无文字层且有图像的页调用 OCR；正式版与 MVP 共享已付费缓存，保留原 PDF 对照；[实现与计费保护](docs/pdf-ocr-design.md)。
- 提供中文统一阅读、关键词搜索、来源筛选、分页、原始通知链接、附件下载、PDF 在线预览和原貌存档。
- 所有业务 API、附件、截图和原貌存档都要求 Feed 登录且实时拥有 `feed.access`。

## 架构概览

```text
Cloudflare Cron
  -> FeedIngest Workflow（每个来源一个实例）
  -> Firecrawl scrape（列表解析 / 正文抓取 / 源站内附件下载）
  -> Worker 桥接（CAPTCHA OCR、超大附件流式上传）
  -> Workers AI（CAPTCHA 识别） / unpdf（PDF 文字层）
  -> R2（正文、原貌、截图、附件、manifest）
  -> D1（来源、通知、附件、运行记录、额度、OAuth BFF 会话、FTS5 索引）
  -> Worker API + React SPA（私有阅读、搜索和存档预览）
```

调度配置为 `0 0 * * *`。Cloudflare Cron 使用 UTC，因此每天 UTC 00:00 运行，即北京时间 08:00。初始补抓窗口是运行时往前 30 天；这不是全量历史导入，更早通知不会被猜测或采集。

搜索使用 D1 SQLite FTS5 `article_search` 的 trigram 分词，索引字段为通知标题和正文文本。少于 3 个字符的查询回退到标题/正文 `LIKE`。正文型 PDF 会用 unpdf 读取文字层，无文字层扫描页由 TextIn 补识别并并入 `body_text`，因此可搜索；普通 Office、压缩包等附件只保存和提供下载，不做通用 Office 文本抽取，也不会并入搜索索引。

## 日常使用

1. 打开 Feed 入口。当前 `wrangler.jsonc` 配置的 `BASE_URL` 是 `https://feed.cqu.moe`。
2. 点击登录，跳转到 auth.cqu.moe。
3. 使用拥有 `feed.access` 权益的账号完成授权。
4. 在“通知”页搜索、筛选来源和翻页；URL 会保留 `q`、`source`、`page`。
5. 打开通知后直接阅读。正文型 PDF 默认展示已保存的原件，可切换到“正文”；普通 PDF 附件不改变默认阅读方式。普通正文渲染纯文本，OCR 结果使用安全 Markdown，不渲染源站 HTML。
6. PDF 阅读器支持上下连续滚动、页码链接、缩放和下载；通知原件、附件预览及网页快照里的 PDF 使用同一阅读器。普通附件列在正文末尾。
7. 阅读切换栏中的“网页快照”在当前页打开所选版本的快照，可通过浏览器后退返回。快照移除源站脚本和表单外壳、限制外部请求，并把已保存的 PDF 阅读区替换为 Feed 受保护的阅读器。
8. 按需打开历史记录或存档信息，查看旧版本、采集记录与截图。切换版本后，正文、原件、附件和快照属于同一版本；未完成版本不会替代当前可读版本。

没有 `feed.access` 的已登录账号会看到无权页。Auth 侧撤销权益后，下一次受保护请求会被 introspection 拒绝。

## 本地开发与验证

要求 Node.js 22.12+ 和 pnpm 11。

```sh
pnpm install
pnpm dev
pnpm test
pnpm build
pnpm check:design
```

- `pnpm dev` 启动 Vite：`http://127.0.0.1:5174`。
- `pnpm test` 使用 Miniflare 覆盖搜索、Range、快照安全、OAuth BFF 和附件上传。
- `pnpm build` 执行 TypeScript 检查并生成 `dist/`。
- `pnpm check:design` 执行 CQU Moe Design 1.1.0 规则检查。
- `pnpm test:browser` 验证构建后页面的阅读、版本切换和 PDF 交互。安装浏览器及独立遥测回归命令见 [通知阅读页验证](docs/design/notice-reading-validation.md)。

通知阅读改版的测试结果与未执行层级见 [通知阅读页验证](docs/design/notice-reading-validation.md)。既有云端和真实会话证据见 [验收记录](docs/acceptance.md)，不代表当前分支已部署或完成新版本账号验收。

## 部署摘要

完整部署顺序、Secret、迁移、运维和故障排查见 [docs/operations.md](docs/operations.md)。重点约束：

1. D1 迁移必须先于 Worker 依赖新表上线。
2. 日常部署 push 到 main，由 Cloudflare Git Connector 检查、构建、应用 D1 迁移并部署；GitHub Actions 负责检查。配置见 [docs/ci-cd.md](docs/ci-cd.md)。
3. `BASE_URL` 必须与 OAuth 回调 origin 一致；更换域名时要同步更新 Auth client 的 redirect URI。
4. Firecrawl、Auth、桥接和管理入口的敏感配置都通过 Workers secrets 注入。
5. R2 桶和 D1 不是公共读；所有文件出口经 Worker 鉴权。

## MVP 边界

- 只覆盖 `worker/sources.json` 中的 5 个站点和已配置的 URL pattern。
- 每个来源每次运行最多采集 40 篇待处理通知；每来源最多跟随 12 页列表。
- 每篇通知最多保存 8 个附件，单个附件最大 64 MiB。
- 全局每日额度：Firecrawl 120 次、OCR 100 次、桥接附件上传默认 256 MiB。
- 额度是硬边界；请求失败也可能已经消耗额度。初始补抓可能跨多天，后续来源会因全局 Firecrawl 额度耗尽而停止。
- 文章内容错误最多自动尝试 3 次；全局额度或提供商限流会延期，不消耗文章重试次数。验证码每附件最多尝试 2 次。
- 原貌存档依赖 SingleFile 生成的 `offline.html`；截图或快照失败会把通知标为 partial。
- 通知日期无法可靠解析时不会入队，避免把无法确定日期的条目误认为 30 天窗口内。

已知限制：扫描 PDF 已接 OCR，但自动识别会有姓名等错字，应对照原 PDF。只处理正文型 PDF，普通附件尚未全文索引。完成的 URL 不会每天重复采集，暂不自动追踪原文后续修改。当前使用 Firecrawl 无密钥入口，曾出现一次 IP 限制 403；后续可配置已有 API key 提高稳定性，未购买服务。

这些边界用于控制外部请求和存储成本：快照、正文、截图、manifest 等小对象写入没有纳入 `archive_bytes` 日额度，R2 总存储和 D1 增长仍需要运维监控。
