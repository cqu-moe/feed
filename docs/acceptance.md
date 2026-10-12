# MVP 验收记录

日期：2026-10-11（Asia/Shanghai）。入口：https://cqu-feed.user-unauthorized.workers.dev/

## 云端业务

首次窗口 2026-09-11 至 2026-10-11；从配置的通知栏目发现 33 篇，文章状态全部 `complete`：

| 来源 | 通知 |
| --- | ---: |
| 教务处 | 8 |
| 国际处 | 6 |
| 土木学院 | 2 |
| 学工部 | 14 |
| 新闻网 | 3 |

D1 读回：63 个附件全部 `complete`，合计 29,133,750 字节；33 个 `snapshot_key`、33 个 `screenshot_key`。附件经过格式签名和 SHA-256 检查后写入私有 R2。超过 2 MiB 的附件经临时桥接直接上传，未把大文件 Base64 塞入 Firecrawl 返回值。

国际处“2027年春季第二批交换生项目（欧洲地区）” ZIP 为 7,603,439 字节，SHA-256 `9577debc0dc352587c1a2f491e2cce9c37967ab74e319425f742a07a84ef4726`。

首次补抓及修复重试共记账 Firecrawl 66 次、验证码 OCR 18 次；大附件桥接字节 11,894,201。计数包含失败尝试，不代表供应商最终账单，也不包含本项目前期试验。未购买新服务。每日 Cron 为 UTC 00:00 / 北京时间 08:00；以手动触发的同一云 Workflow 路径验收，尚未等待次日定时触发。

## 真实账号

- Auth PR [#57](https://github.com/cqu-moe/auth/pull/57) 已合并；主分支 CI 和 Cloudflare 构建通过。
- Auth D1 只存在 1 个 `feed.access=1`，且匹配用户指定账号；未覆盖其其他权益。
- 用户完成 Auth 登录后，Feed 显示账号 DoubleU，并能读取真实 33 条通知。
- 搜索“优异生”返回 1 条教务处通知；真实详情有正文、原貌存档和 7 个文件。
- 通过真实登录浏览器下载 `附件2：优异生申请表.doc`，17,920 字节；下载文件 SHA-256 为 `86022bda7217ee6f70ace068008d00d8e32a5663ba5d3e53fc05cea0e152b5c9`，与 D1/R2 保存记录一致。
- 未登录直接请求列表、文件和快照均为 401。缺权益、实时撤销、Auth 故障与 logout 在隔离协议集成测试中验证，没有撤销生产用户权益进行测试。

浏览器只用于用户登录后的产品验收；发现通知、抓正文、识别验证码、下载附件、生成快照均发生在 Firecrawl/Cloudflare 云端。

## 原貌和阅读

- R2 保留原始 HTML、SingleFile HTML、原始 PDF/Office/ZIP、截图、正文与带摘要的 manifest。
- 修复学校把正文包在 form 内时误删整篇的问题：只拆除表单外壳并以 CSP 禁止提交。
- 只允许已存档 PDF 的 iframe，重写为鉴权后的 Feed 文件地址；移除 SingleFile 附加 sandbox，使用自托管 React-PDF 11 / PDF.js 6.3.289，其他源站脚本、事件、未知 frame 保持禁用。
- 原貌存档中已实际显示已保存 PDF 的第一页，并点击翻页到 2 / 2。阅读器直接解析 R2 原始 PDF 字节，未把文件替换为截图。
- 清理 PDF 元数据、阅读器提示与导航噪声，更新 D1 正文和 FTS；R2 原始产物保持不变，清理前派生文本已有本地可恢复备份。
- 初始转换器有 12 篇 PDF 未取得正文；换用 Workers 内的 unpdf 后，从 R2 补建了其中 11 篇的正文索引。当时 32/33 篇有正文文本；后续已用 Mistral OCR 4.1 为剩余 `4ffc0415b5f4ba168a847f01` 补建正文和索引，见下方 OCR 验收。普通 PDF、Office、压缩包附件仍未通用全文索引。

## 代码验证

- `pnpm test`：13 个测试，覆盖中文搜索、PDF Range/HEAD/416、快照安全与 PDF 保留、OAuth PKCE/state/nonce/浏览器绑定和权益、R2 多 MiB 上传、全局限流延期与单篇尝试次数、非完整任务不能标 complete。
- 快照 form 和 PDF sandbox 两项回归均先观察失败，再修复通过。
- `pnpm build`、`pnpm check:design`、`git diff --check`：均通过。Vite 主包超过 500 KiB 的警告尚存。
- 学工部已切换为官方公示公告列表，补充翻页复核完成；未发现额外30天通知，所有来源最近一次运行均无错误。
- 前端固定 API fixture 已检查浅色/深色和 390/768/1440、320 重排；真实数据另做本记录中的业务验收，新阅读器另以真实会话检查 390px 宽度，正文、工具栏和翻页可用；未覆盖所有手机系统。

## 运行边界

- 来源是 `sources.json` 的选定通知栏目，不等同于遍历五个站点所有页面。日期可靠且在窗口内才入队；倒序列表遇到整页旧通知停止翻页。
- 每篇最多 8 个附件、单文件 64 MiB、每来源每 run 40 篇、12 页列表；超过限制记录不完整，不伪报成功。
- 全局限流和预算延期不吞掉文章尝试次数；文章内容错误最多 3 次后需人工排查。
- 已完成 URL 不重复抓取，暂不自动检测原文更新。R2 旧版本保留，尚无自动保留期清理。
- Firecrawl keyless 曾返回公共 IP 限制 403，重试后成功；可配置已有 API key，当前未配置。每日限额是请求尝试边界，并非整个 Cloudflare 账单硬封顶。

OCR 接入前应用版本：`32833335-94c9-4c5a-bd0d-7c1a1c4838ba`。PDF.js 采用独立懒加载包，字体、CMaps、WASM 与 Worker 脚本都随应用自托管；仅阅读器页面允许同源嵌入与 WASM。

PDF 正文补索引在生产 Worker 内执行，未新增 Firecrawl/OCR 调用；`unpdf@1.8.1` 的 Workers 运行时测试通过，完整测试最终为 13/13。管理接口仅接受已有通知 ID，使用原有 ADMIN_TOKEN 鉴权，不接受外部文件 URL。

## Mistral OCR 实测与上线（同日后续）

- 现有 8 页扫描 PDF 在 Cloudflare Worker 中直接输入 Mistral OCR 3/4.1，每模型一次。两者均输出 287 行名单；实际使用 8+8 页，标准估算合计 $0.048，未购买订阅。详细复核及限制见 [ocr-comparison.md](ocr-comparison.md)。
- 默认模型选 `mistral-ocr-4-1`；固定版本、不同时自动运行双模型。新正文 PDF 入独立 Workflow，每日补偿；每日 50、每月 1000 个预留页，文件/模型/页组去重并限制付费尝试次数。
- 复用 4.1 缓存发布，没有增加付费请求。最终 D1 仍为两次供应商调用、16 processed pages；文章 OCR 结果和 FTS 已更新。原 PDF、原貌 HTML、截图未改。
- 真实登录账号 DoubleU 搜索“奖贷金”可命中该通知；D1 FTS 查询样片首行学号也命中该 article ID。OCR 文字作为搜索来源，不是只按标题命中。
- 真实页面显示 8 页识别结果、7 个 HTML 表格、287 个数据行。点击第 2 页“打开原 PDF”后地址为 `?page=2`，阅读器显示 `2 / 8`，原 PDF 名单图像实际渲染成功。
- 手机端验收发现长附件名横向撑宽页面，已修复；390/768/1440 宽度下页面无横向溢出，表格在独立区域内横向滚动。浅色/深色均目视检查，结束后恢复跟随系统和默认 viewport。
- 旧 R2 body.txt 中阅读器下载提示、PDF 元数据再次进入 OCR 正文的问题已修复，并补充回归；现有样片已重新发布清理后的缓存结果。
- 未登录访问 OCR 文章、原 PDF、OCR admin 均返回 401。原有 feed.access 鉴权继续生效；没有为测试修改真实用户权益。
- 最终 `pnpm test` 23/23、`pnpm build`、`pnpm check:design`、`git diff --check` 通过。Vite >500 KiB 警告仍在；没有 Feed GitHub remote，因此无 Feed CI 声明。
- 最终生产版本：`4e51a2f3-dab2-41bf-b674-329a704b975c`。Mistral secret 已由用户配置，只在 Worker 内使用。

本次只实测了一份扫描 PDF，不代表所有中文名单均可准确识别；4.1 仍有姓名错字，阅读界面明确提示以原 PDF 为准。尚未等候次日 Cron；此次真实 OCR Workflow 由管理接口发起，自动入队和每日补偿已部署。


## 2026-10-13 TextIn 正式版适配

已恢复签名 MVP `7fb8e2a` 的 TextIn adapter、无文字层扫描页选择、普通附件 legacy 提取与 R2 计费保护；历史 Mistral 验收记录保留，但当前默认为 `textin-xparse-auto`。正式任务与 MVP 共用缓存/receipt，迁移保留已付费结果。此次只运行本地 Worker/D1/R2 外部替身回归与 CI；不据此声称 TextIn 云调用、价格、部署、真实账号或 UI 验收通过。具体 red/green、最终签名和风险见本次 `feed-textin-production-implementation.md` 交付记录。
