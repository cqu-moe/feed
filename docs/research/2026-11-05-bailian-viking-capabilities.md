# Feed 选型：阿里云百炼文档知识库与火山 Viking 知识库

2026-11-05，按中国站官方文档对比。范围是从文章入库到返回可引用的搜索结果；不比较速度或召回率，不把厂商的模型榜单当作知识库成绩。

**建议：优先选百炼的「文档搜索」型知识库，使用检索 API。** 两家都能代管模型和索引，真正影响 Feed 选择的是组合筛选、PDF 结果定位、文件更新与低价版本的限制。

| 能力 | 阿里云百炼 | 火山 Viking |
|---|---|---|
| 网页正文与 PDF 入库 | 支持 HTML、Markdown、TXT、PDF、Office；电子 PDF 直接取文字，扫描件自动 OCR。提供版面 OCR、结构恢复和视觉解析选项。单个 PDF 上限 150 MB 或 1,000 页。[创建配置](https://help.aliyun.com/zh/model-studio/rag-knowledge-base) · [规格](https://help.aliyun.com/zh/model-studio/rag-knowledge-base-specifications) | 支持相同核心格式，图文 PDF 可 OCR；富文本库还列出 EPUB、图片、音视频等，PDF 单文件上限 1 GB、5,000 页。[格式配额](https://docs.volcengine.com/docs/vector-database-vikingdb/know-ledge-base-quotas?lang=zh) · [解析 FAQ](https://docs.volcengine.com/docs/vector-database-vikingdb/faqs?lang=zh) |
| 切片与表格 | 文档可按页、标题、长度、正则或智能切分。Excel 按行切、首行作字段名；不要将此等同于所有 PDF 表格都能无损还原。[切片与格式](https://help.aliyun.com/zh/model-studio/rag-knowledge-base-specifications) | 表格型切片可返回 Markdown 或 HTML；结构化数据可返回整行字段。**专门的结构化知识库是旗舰版功能**，与富文本库接受表格文件是两回事。[返回结构](https://docs.volcengine.com/docs/vector-database-vikingdb/search-knowledge-3?lang=zh) · [版本规格](https://docs.volcengine.com/docs/vector-database-vikingdb/know-ledge-base-quotas?lang=zh) |
| 中文关键词、语义与排序模型 | 文档检索支持关键词和向量两路召回；可选 `text-embedding-v4`，用 `qwen3-rerank` 等重排，可配置两路候选数、返回片段数和阈值。创建时宜显式选模型。[知识库](https://help.aliyun.com/zh/model-studio/rag-knowledge-base) · [检索流程](https://help.aliyun.com/zh/model-studio/rag-knowledge-retrieval) | 标准版固定 `Doubao-embedding-240715 + 关键词模型`；旗舰版可选更多向量模型。检索接口可调语义与关键词的权重、可打开 `doubao-seed-rerank` 等重排，默认关闭。两家的「关键词检索」都不应解读成对任意两个相邻汉字的子串匹配承诺。[版本规格](https://docs.volcengine.com/docs/vector-database-vikingdb/know-ledge-base-quotas?lang=zh) · [检索参数](https://docs.volcengine.com/docs/vector-database-vikingdb/search-knowledge-3?lang=zh) |
| 发布日期、部门、栏目 | 检索服务可声明并过滤标签和自定义元数据；Retrieve 的范围过滤适用于数值，适合把发布日期存成整数。部门和栏目用稳定 ID，避免改名导致旧文档筛不出来。[知识检索接口](https://help.aliyun.com/zh/model-studio/knowledgesearch) · [过滤语法](https://help.aliyun.com/zh/model-studio/how-to-use-search-filters) | `doc_filter` 可组合条件和范围，字段要预先登记；官方用部门标签做过滤的教程明确要求旗舰版，标准版配额表也写明不支持知识库标签。因此按有文档依据的方案，Feed 的标签筛选应按旗舰版估价；不能由通用 API 反推标准版支持同等自定义过滤。[部门标签教程](https://www.volcengine.com/docs/84313/2192050) · [检索](https://docs.volcengine.com/docs/vector-database-vikingdb/search-knowledge-3?lang=zh) |
| 只搜原文、定位 PDF | 知识检索可直接返回切片、分数、文档名；非结构化文档的元数据列有 `page_number` 页码列表。调用方无须订购一个生成答案步骤。[返回字段](https://help.aliyun.com/zh/model-studio/knowledgesearch) | 也可只检索，返回原文、文档 ID、切片 ID、分数和内容类型。所查检索响应的 `ChunkID` 是切片次序，不能当作 PDF 页码。这不是说所有火山接口均不支持定位。[检索返回](https://docs.volcengine.com/docs/vector-database-vikingdb/search-knowledge-3?lang=zh) |
| 存储、同步与更新 | 平台可同时托管文件数据集及检索索引；向量存储默认用平台，也可选自购 ADB-PG。支持异步追加、查进度、删除库内文档及切片，删除库内文档不等于删除数据源原件。[创建](https://help.aliyun.com/zh/model-studio/rag-knowledge-base) · [追加](https://help.aliyun.com/zh/model-studio/api-bailian-2023-12-29-submitindexadddocumentsjob) · [删除](https://help.aliyun.com/zh/model-studio/api-bailian-2023-12-29-deleteindexdocument) | 服务托管向量与索引，向量相关存储与原文件大小不是同一口径；支持用相同 `doc_id` 上传新文件覆盖旧文档，对频繁修订的通知方便。[更新 FAQ](https://docs.volcengine.com/docs/vector-database-vikingdb/faqs?lang=zh) · [存储计费](https://docs.volcengine.com/docs/vector-database-vikingdb/billing-of-a-knowledgebase?lang=zh) |
| Feed Worker 集成 | 可用服务端 Bearer API Key 走 REST；使用知识检索服务时，先在控制台发布配置，Worker 传服务 ID、查询、过滤条件，取 `nodes`。[HTTP 接口](https://help.aliyun.com/zh/model-studio/knowledgesearch) | 数据面支持 API Key，Worker 可走 HTTP；知识库检索和问答是独立能力。[FAQ](https://docs.volcengine.com/docs/vector-database-vikingdb/faqs?lang=zh) · [检索 API](https://www.volcengine.com/docs/82379/1273574) |
| 标准版规格与费用 | ¥0.03/库/小时，30 天 ¥21.60，含最多 100 GB 平台存储，1 QPS；嵌入与重排按使用量另计。[计费](https://help.aliyun.com/zh/model-studio/billing-for-knowledge-base) | 基础费 ¥0.0416/库/小时，30 天约 ¥29.95；单库 500 文档，每天 300 次检索，1 QPS。旗舰版计算 ¥0.45/CU/小时，另计向量存储等，不能用标准版价格估有标签的方案。[计费](https://docs.volcengine.com/docs/vector-database-vikingdb/billing-of-a-knowledgebase?lang=zh) · [配额](https://docs.volcengine.com/docs/vector-database-vikingdb/know-ledge-base-quotas?lang=zh) |

**对 Feed 的落点：**R2 继续保管原 PDF 与已有 OCR，D1 继续保管文章、版本和栏目。知识库只保存可重建的搜索副本。若传原 PDF，可用供应商的 PDF 解析和页码；若传 Feed 已解析的 Markdown，应附上原 PDF 的页码映射，不能把 Markdown 的分页当原件页码。搜索结果仍回到 Feed 的阅读权限和受保护原文地址。若主要需求今后变为超长 PDF、富媒体检索或结构化表格行定位，再考虑 Viking 旗舰版。
## 设计讨论：百炼为首选，待审批

保留已提出的产品范围：一个搜索入口，同时支持中文关键词、语义和发布日期/部门/栏目组合筛选；网页正文和仅以 PDF 发布的通知均能搜到。原件与阅读权限仍由 Feed 管理。本轮不做供应商性能对比。

三项产品规则已确认：① 返回相关通知，保留中文短词命中能力，不承诺列全、不另建全文索引；② 正文型 PDF 必须解析，普通 PDF 有可提取文字或已有 OCR 就纳入，普通扫描件不新增付费 OCR；③ 部门按实际收录栏目所属的站点。见[完整接入方案（待审批）](../specs/bailian-notice-search.md)。
