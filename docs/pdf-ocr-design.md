# PDF 文字提取与 TextIn OCR

基于 2026-10-12 MVP、2026-10-13 正式适配。默认 `textin-xparse-auto`；下述 legacy 流程覆盖正文和普通 PDF 附件，正式版本的适配与范围见末节。Mistral 适配器保留用于已有对比结果，自动任务不再选择它。

## 云端流程

```text
采集 PDF → 私有 R2 → PdfOcrWorkflow → unpdf 逐页检查
  → 有任何非空文字层：直接提取，不调用 OCR
  → 无文字层且有图像：TextIn xParse sync，选择对应页码
  → R2 原始响应 → 安全 Markdown/逐页文本缓存 → D1 正文与 FTS5 → 统一阅读
```

生产运行在 Cloudflare 与 TextIn，不调用 Browser Run，不依赖本机浏览器或 PDF 转图服务。TextIn 直接接收已下载的 PDF。扫描检测严格遵守“只处理无文字层”：即使只有一个页码、短标题也跳过 OCR，因此部分文字层加扫描正文的页面可能漏掉图中文字。无图无文字的空白页也跳过。

- `worker/pdf-text.mjs`：unpdf 逐页提取与扫描检测。
- `worker/textin-ocr.mjs`：固定 API、multipart、1 基页码转换、响应范围校验、表格转 GFM。结构化表格与普通文字共同进入阅读和搜索；原始字符/坐标数据保留在私有 R2。
- `worker/pdf-ocr.mjs`：Workflow、文件缓存、请求记录、全局预算和安全发布。
- `src/ocr-reading.tsx`：Markdown/GFM 按页阅读，链接对应原文件与页码；不执行供应商 HTML、不加载外部图片。

原 PDF、HTML、截图不修改。派生阅读保留 HTML 正文，再拼接 PDF 文本。发布核对当前附件 hash、归档 prefix 与正文 hash；FTS5 触发器同步索引。业务 API 和所有文件继续检查 Feed BFF session 与 `feed.access`。

## 缓存和防重复计费

缓存按 PDF SHA-256、固定引擎、请求配置摘要、文字层策略和适配版本区分，与文章 URL 无关。同文件跨通知复用；文件变化生成新缓存；配置版本变化必须先迁移旧结果/raw/receipt，不能直接换键重付。

```text
derived/pdf/<sha>/<model>/<version-and-config>/native.json
derived/pdf/<sha>/<model>/<version-and-config>/ocr-<pages>.json.request.json
derived/pdf/<sha>/<model>/<version-and-config>/ocr-<pages>.json.raw.json
derived/pdf/<sha>/<model>/<version-and-config>/ocr-<pages>.json
derived/pdf/<sha>/<model>/<version-and-config>/result.json
derived/reading/<article-id>/<content-hash>/reading.json
```

1. 先查完整结果、页组缓存、原始响应与此前付费的同配置 TextIn benchmark。
2. D1 原子 lease 避免同文件并发调用；发送前用 R2 条件写入不可覆盖的请求记录。
3. 收到有界 TextIn 响应后先保存原始字节，再解码 JSON、校验/转换，最后保存规范化结果。
4. 网络超时、响应损坏等已发请求失败标为 `needs_review`，每日任务不自动再次付费。手动重新入队也必须先复用原始响应；已有请求记录而没有可用结果时拒绝再次调用。
5. 预算不足标为 `deferred_budget`，并发占用标为 `deferred_busy`，可由每日任务恢复。缓存读取和原生文字提取不需要供应商凭据。

这个设计选择“未知结果时停下”，不声称外部服务支持 exactly-once。供应商成功但响应完全丢失时，需要人工对账恢复，不能直接删除请求记录重试。缓存和请求记录不设置自动过期。解析故障修复可重用当前缓存中的 raw JSON，不必重新识别。未来升级缓存版本、页组方式或扫描判定策略时，应先显式迁移旧 raw/请求记录，不能把换 key 当作免费重算。历史 8 页 TextIn 测试结果在源 hash 与请求配置完全匹配时直接升级为阅读缓存。

## 费用与限制

- 每日 50、每月 1000 个预留源页（UTC）；每次请求保守预留完整源 PDF 页数，失败不退额度。成功页数与请求记录另存，不能当成供应商发票。
- 每文档最大 12 MiB、100 个源页、20 个扫描页，每次最多选择 10 个扫描页。超限保留原件，OCR 停止。
- TextIn 请求最长 180 秒，响应上限 24 MiB；规范化派生产物写入上限 12 MiB。
- TextIn 账号实际单价未自动获取，不把历史 Mistral 美元单价套用到 TextIn；结果和管理状态的美元估算为 null。`pdf_ocr_usage.estimated_usd` 仅累积 Mistral 的历史美元估算，TextIn 以页数计量并对账账号余额。
- Cloudflare 费用不包含在供应商页数预算中。OCR 并非免费，缓存命中与原生文字提取不产生新供应商识别调用。

## 运维

使用已有 `0004_pdf_ocr.sql` 表，无新增迁移。Secret 为 `TEXTIN_APP_ID` 与 `TEXTIN_SECRET_CODE`；凭据只发送给 TextIn，不发送 Auth Cookie，也不公开 R2。

```sh
pnpm exec wrangler secret put TEXTIN_APP_ID --name cqu-feed
pnpm exec wrangler secret put TEXTIN_SECRET_CODE --name cqu-feed
node scripts/compare-ocr.mjs status
node scripts/compare-ocr.mjs publish textin-xparse-auto
FEED_ARTICLE_ID=<article-id> node scripts/compare-ocr.mjs publish textin-xparse-auto
```

`publish` 会优先复用结果；首次扫描件可能付费。管理 API 仍为 `/internal/pdf-ocr/<article-id>`（ADMIN_TOKEN）：GET 状态、GET `?model=...` 私有结果、POST `{ "model":"textin-xparse-auto", "publish":true }` 入队。`needs_review` 自动停住；不要为恢复而清空 calls、预算或 R2 请求记录。

每日 Cron 同时接新通知并补偿未完成的 PDF。`PDF_OCR_ENABLED=false` 停止自动入队，已启动 Workflow 不撤销。普通 Office/压缩附件暂不全文索引；加密、损坏、超大或文字仅由矢量轮廓构成的 PDF 不保证提取。OCR 仍可能错姓名和数字，原 PDF 保留作对照；不生成新的隐形文字层 PDF。

## 正式版本适配（2026-10-13）

正式链路使用 `ArchiveOcrWorkflow`，默认 `textin-xparse-auto`；只配置 `TEXTIN_APP_ID` / `TEXTIN_SECRET_CODE` 即可。既有 Mistral 结果仍可读，显式模型对比仍兼容；正常采集不要求 Mistral 凭据，也不自动降级到另一供应商。

`textin-ocr` descriptor 固定 `pdf-no-text-v1` 判定、`TEXTIN_CACHE_VERSION=v1` 与完整请求模板（包括 auto、字符详情、表格结构等）；选中页组进入独立缓存键。payload 必须匹配冻结的 options hash 与支持的请求配置，配置漂移时停止。当前 MVP 命名空间为 `derived/pdf/<sha>/textin-xparse-auto/v1-no-text-75eefb13df7f1ce9/`，正式版直接复用其中完整结果、十页组、raw 与不可覆盖的 request receipt。只改 `ARCHIVE_OCR_PROCESSOR_VERSION` 会新建派生身份，不会绕开这个已付费缓存。

正式结果另写 `derived/ocr/<inputHash>/<processor>/<processorVersion>/<optionsHash>/result.json` 及不可变 hash 对象；D1 derived output、revision requirement 和 ready/reconcile 规则不变。历史版本冻结旧结果；当前阅读重建不产生源版本或通知事件。迁移除正文 PDF 外，也接纳普通 PDF 附件已有的完整 MVP OCR/原生文字结果，保留原键和全文检索。正式新采集的必要 OCR 范围仍为正文 PDF；legacy Workflow 继续支持全部 PDF 附件，不将两条采集链路的范围混称为全面附件 OCR。

TextIn 请求超时、解析失败或原始响应写入失败后，正式 task 为 `blocked`，attempt `error_code=ocr_review_required`，不会由自动恢复再次付费。并发占用为 `deferred/ocr_busy`；MVP 分别为 `needs_review` 和 `deferred_busy`。已有 raw 可由修复后的解析器重建，无可用 raw 且存在 receipt 时必须人工对账，不能清除凭据或换键自动重付。OCR 页组没有自动过期；D1 lease 的释放带原租约条件，R2 receipt 是最终防重边界。

此次实现的验证为本地真实 Worker/D1/R2 加外部 OCR 替身，没有实际付费请求、部署或浏览器验收。适配协议来自已验证签名 MVP `7fb8e2a`；供应商账号价格、真实服务限额与生产 Secret 就绪仍由上线验收确认。
