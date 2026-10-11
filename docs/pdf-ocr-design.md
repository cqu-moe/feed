# 扫描 PDF OCR 实现

2026-10-11。已完成真实云端 A/B 识别，默认采用 `mistral-ocr-4-1`。实测方法、质量和成本见 [ocr-comparison.md](ocr-comparison.md)，官方资料见 [ocr-provider-research.md](ocr-provider-research.md)。

## 流程

```text
采集 PDF → 私有 R2 → PdfOcrWorkflow → unpdf 逐页检查
  → 有效文字层：免费本地解析
  → 扫描页：Mistral /v1/ocr（内联 PDF bytes + 零基页码）
  → R2 保存原始响应、逐页结果 → D1 正文与 FTS5 → 按页阅读、原 PDF 对照
```

生产全链路在 Cloudflare 和 Mistral 运行，不调用 Browser Run，不依赖本机浏览器。实测时的本地 PDF 渲染仅用于人工质检。

- `worker/pdf-text.mjs`：逐页提取文字、检测图像与乱码。图像页少于 80 个非空白字符，或乱码比例超过阈值时进入 OCR。
- `worker/mistral-ocr.mjs`：固定官方 API endpoint；校验模型白名单、PDF 签名、大小、页码、响应完整性和 usage；按表格 ID 展开占位符。直接使用 fetch，无额外供应商 SDK。
- `worker/pdf-ocr.mjs`：独立 Workflow、去重、额度、结果落盘和发布。采集成功后入队，每日 Cron 补偿未完成任务。
- `src/ocr-reading.tsx`：安全 Markdown/GFM 表格，按页展示，可打开 `/reader/{articleId}/{filename}?page=N`。不执行 OCR 返回的 HTML 或加载其外部图片。

## 存储与一致性

迁移 `0004_pdf_ocr.sql` 新增 jobs、calls、budget、usage 表，以及 articles 的 OCR 派生信息。文档状态为 pending/running/complete/deferred_budget/failed，与原件存档状态分开。

R2 原 PDF、HTML、截图不修改。派生缓存按 SHA256 + 固定模型 + 配置版本区分：

```text
derived/pdf/<sha256>/<model>/v1/native.json
derived/pdf/<sha256>/<model>/v1/ocr-<selected-page-indices>.json
derived/pdf/<sha256>/<model>/v1/result.json
derived/reading/<article-id>/<content-hash>/reading.json
derived/reading/<article-id>/<content-hash>/reading.txt
derived/reading/<article-id>/<content-hash>/previous-body.txt
```

响应先保存到 R2，再标记任务完成，再发布正文。发布核对当前附件 hash、归档 prefix 和正文 content hash；旧源文件任务不能覆盖新附件。重新采集时清理旧 OCR 指针。保留非 PDF 的 HTML 正文，替换旧 PDF 派生文本，FTS5 触发器同步索引。相同文件跨文章复用识别结果，阅读访问仍受对应文章的 feed.access 保护。

所有普通用户读取仍走 Feed BFF session + Auth 实时权益检查。Mistral key 只作为 Worker Secret，原 PDF 以内联数据输入供应商，不公开 R2，也不传 Auth Cookie。

## 费用控制

- 原文字层免费解析，当前只自动处理 `role=body-pdf`。普通 PDF/Office/压缩包附件的全文索引另行实现。
- OCR 默认 `mistral-ocr-4-1`，基础 OCR 按 $4/1000 页估算；不启用 annotations、Batch 或供应商缓存折扣假设。
- 默认每日 50、每月 1000 页尝试（UTC）；每次请求保守按完整源 PDF 页数预留，即使只选部分页。额度由一个 D1 行原子更新，失败不退额度。
- 每文档最多 12 MiB、100 个源页、20 个 OCR 页；每请求最多 10 个待 OCR 页。超限停止 OCR，原件仍可读。单请求 120 秒超时、响应上限 8 MiB。
- 全局文件/模型/页组缓存及 lease 防重，每页组最多两次付费尝试，文档自动重试也受次数限制。网络失败不会立即循环付费重试；未耗尽次数的失败任务由后续每日补偿恢复。预算耗尽不消耗付费尝试次数。
- 1000 个预留页按默认模型对应约 $4 的基础 OCR 用量规模；不是整个云账号账单硬封顶，也不包含 Cloudflare 费用。usage_info 与发票仍需对账。

## 管理与边界

`GET /internal/pdf-ocr/<article-id>` 读状态；加 `?model=<exact-id>` 读取完成的原始对比结果。`POST` JSON `{ "model": "mistral-ocr-4-1", "publish": true }` 创建任务或复用结果发布。全部要求 ADMIN_TOKEN。

`scripts/compare-ocr.mjs` 固定首份扫描样片，支持 status/start/results/publish；results 写入忽略的 `.private/ocr-comparison/`。publish 已完成的模型不会再调用供应商。`scripts/evaluate-ocr.mjs` 只比较本地私有结果和人工转录，不发 API 请求。

目前按页的扫描检测是启发式：较多原文字与图中文字混在同一页时可能漏掉图中文字；未做所有 PDF 类型的质量验证。空白无图页跳过，有图但 OCR 返回空文本会标失败待检查。超大/加密/损坏文件只保留原件，不保证 OCR。没有生成隐形文字层 PDF、逐字高亮或置信度复核系统。自动识别可能把姓名、数字识别错，界面提供原 PDF 对照，不把识别结果当作校方名单的替代原件。
