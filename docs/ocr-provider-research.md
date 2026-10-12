# CQU Feed 扫描 PDF OCR 方案调研

> 历史选型研究。2026-10-13 正式版已按用户纠正沿用已验证 TextIn MVP；当前默认、缓存和计费保护以 [pdf-ocr-design.md](pdf-ocr-design.md) 为准。以下 Mistral 调研与对比证据保留，不代表当前默认。
调研日期：2026-10-11。下文保留实测前的官方文档调研；后续已完成两模型真实云端对比并选定 OCR 4.1，当前结论以 [实测报告](ocr-comparison.md) 和 [实现说明](pdf-ocr-design.md) 为准。

## 结论

首轮样片建议使用 Mistral OCR 4.1，并固定精确模型 ID `mistral-ocr-4-1`。官方模型页标记其为 GA、版本 4.1、发布于 2026-07-16；`mistral-ocr-4` 与 `mistral-ocr-latest` 也是官方别名，但固定 `mistral-ocr-4-1` 更利于结果与费用可复现。OCR 3 官方模型页仍标明可用，标准价 $2 / 1000 页；4.1 能提供段落框和置信度，但对本项目中文内容的质量提升尚未实测，应保留 OCR 3 作为成本对照，不能仅凭新旧版本断言必须升级。

私有 R2 附件不需要暴露通用公网下载地址。Mistral OCR 官方支持两种避开通用公网 URL 的输入：第一，把 PDF bytes 编成 `data:application/pdf;base64,...` 后放入 `document_url`；第二，先用 Files API 以 `purpose="ocr"` 上传，官方说明该文件仅可通过 API key 访问，再取得 signed URL 传给 OCR。未发现 `/v1/ocr` 能直接接收 `file_id` 的官方写法，因此“上传后换 signed URL”是已核实路径，不应臆造 direct file id 参数。

## Mistral OCR 4.1

### 模型与价格

- 精确模型 ID：`mistral-ocr-4-1`；别名：`mistral-ocr-4`、`mistral-ocr-latest`。官方模型源码三者指向 OCR 4.1。
- 标准 `/v1/ocr` 价格：OCR `$4 / 1000 pages`；带 annotation 的页 `$5 / 1000 annotated pages`。官方 pricing 页另列出 cached input `$0.4 / 1000 pages`，但缓存命中条件与计费口径未在本次材料中说明，不能直接当作重复 PDF 的稳定折扣设计。
- Batch：模型能力与 `/v1/batch` 支持 OCR，官方 cookbook 说明 Batch inference 有 50% cost reduction。按该规则推算基础 OCR 约 `$2 / 1000 pages`，但 inspected pricing 表没有单独列出 OCR 4.1 的 Batch 单价；该推算需在账单或控制台复核，不能写成已核实的正式单价。

### 选择页与计费

`/v1/ocr` 的 `pages` 参数支持整数数组或逗号/区间字符串，例如 `0,1,2`、`0-5`、`0,2-4`，页码从 0 开始。响应包含 `usage_info.pages_processed` 和 `doc_size_bytes`。工程上应以 `usage_info.pages_processed` 作为每次 OCR 处理页数记录，并按 `$4/1000` 估算标准成本。

官方没有明确说明选择页请求的发票是否严格等于 `pages_processed`，也没有说明失败页、空页、重复请求或 Batch 的最小计费单位。因此推荐实现时把模型响应中的 `usage_info` 原样入账，再与 Mistral 用量报表对账；不要只按本地 PDF 总页数或 selected pages 长度估算。所选页是否“只按选定页计费”在这一发票细节上仍为未核实。

### 输出与质检

OCR 响应逐页返回 `index`、`markdown`、`images`、`tables`、`hyperlinks`、页尺寸、`usage_info` 等。开启 `include_blocks=true` 后，每页返回 `blocks`：段落级 bbox、结构类型、内容与阅读顺序。`confidence_scores_granularity` 可选 page/block/word；page 包含平均和最低置信度，block 包含内容平均/最低置信度与类型置信度，word 包含 token/word 的 confidence 与 `start_index`。这些字段足够做低置信页告警、人工复核队列和搜索索引前的质检。

官方称支持 40 种以上语言，并链接到 OCR supported languages 列表；本次未继续打开语言矩阵，因此不宣称“中文已官方支持”或给出中文准确率。中文扫描件质量仍需用真实样片验收。Mistral OCR 的最大 PDF 页数、单请求文件大小、Files API 保存期限，以及按账号 tier 的 OCR pages-per-minute 数值也未在本次 inspected docs 中核实；正式上线前应从官方 limits 页面或控制台确认。

## Firecrawl 对照

Firecrawl `/parse` 可通过 multipart 上传本地/非公开文件 bytes，适合由后端读取私有附件后提交；`/scrape` 则面向可访问 URL。PDF parser 可选 `fast`、`auto`、`ocr`：`fast` 只取内嵌文本，`auto` 对无文本页 fallback OCR，`ocr` 强制每页 OCR。输出支持 `pages[].pageNumber/markdown`，`blocks` 提供每页宽高、归一化 bbox、类型、内容、阅读顺序、来源与 confidence；`pages`、`blocks`、`pageMarkers` 不额外收费。计费为 1 credit/page，单次 `/parse` 最大 50 MB，默认超时 30 秒、最大 300 秒，`maxPages` 可限制处理范围。

Firecrawl 官方文档没有给出中文语言矩阵或准确率承诺，也没有暴露底层 OCR 引擎；其 block 坐标和 confidence 对前端高亮/复核有用，但作为扫描中文 PDF 的主力 OCR 质量仍未验收。相较之下，Mistral 是专用 OCR 模型、输入与逐页结构更清晰、价格可直接按页估算，因此建议 Mistral 为主，Firecrawl 仅作为已采集链路上的对照组或后备实验。

## 建议

1. 新 OCR 任务固定 `mistral-ocr-4-1`，优先 Base64 直传小 PDF；较大或重复处理文件再走 Files API `purpose=ocr` + signed URL。
2. 保存每页 `markdown`、`blocks`、confidence、页尺寸、模型 ID、`usage_info.pages_processed`，低置信页进入人工复核。
3. 成本先按 `$4/1000` 标准价与 `pages_processed` 估算；Batch 与缓存折扣只作为后续优化，待真实账单确认。
4. 上线前用 10–20 个真实中文扫描附件做离线验收，指标至少包括整字错误、标题/表格/公章遮挡页表现、bbox 偏移和低置信覆盖率。

## 官方来源

- Mistral OCR API：<https://docs.mistral.ai/api/endpoint/ocr>
- Mistral OCR 4.1 模型页：<https://docs.mistral.ai/models/ocr-4-1>
- Mistral API pricing：<https://docs.mistral.ai/inference/pricing>
- Mistral OCR Processor 文档源码：<https://github.com/mistralai/platform-docs-public/blob/main/src/content/en/docs/studio/document-processing/basic_ocr/page.mdx>
- Mistral OCR 模型源码：<https://github.com/mistralai/platform-docs-public/blob/main/src/schema/models/models/ocr-4-1.ts>
- Mistral OCR Batch cookbook：<https://docs.mistral.ai/resources/cookbooks/mistral-ocr-batch_ocr>
- Firecrawl Parse：<https://docs.firecrawl.dev/features/parse>
- Firecrawl Parse API：<https://docs.firecrawl.dev/api-reference/endpoint/parse>
