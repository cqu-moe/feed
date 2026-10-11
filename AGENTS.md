# CQU Feed 开发入口

全云端通知采集、私有存档与统一阅读。用户业务需求以当前会话为准。

- `README.md`：功能、来源范围、运行方式及已知边界。
- `docs/operations.md`：Cloudflare、Auth、迁移、额度与运维。
- `docs/acceptance.md`：实际验收证据与未验证事项。
- `worker/workflow.mjs`、`discovery.mjs`、`collect.mjs`：云任务与存档。
- `worker/page-action.mjs`、`bridge*.mjs`：Firecrawl 源站浏览器与临时 OCR/上传桥接。保留 origin、HMAC、有效期、文件签名和额度校验。
- `worker/auth.mjs`：独立 BFF 会话。所有业务 API、R2 文件、截图、快照均实时检查 `feed.access`。
- `worker/storage.mjs`：受保护文件流、Range 和静态快照。只给已保存的 PDF 嵌入自托管 PDF.js 阅读框；源站脚本与表单提交保持禁用。
- `worker/pdf-ocr.mjs`、`mistral-ocr.mjs`：扫描正文 PDF 云 OCR、缓存和页数预算。见 `docs/pdf-ocr-design.md`；真实对比见 `docs/ocr-comparison.md`。识别输出为派生内容，不覆盖原 PDF。
- `src/`：CQU Moe Design 1.1.0 阅读界面。先读 `node_modules/@cqu-moe/ui/dist/START-HERE.md`；基础组件来自 `@cqu-moe/ui`，样式使用语义变量，不覆盖 `.ds-*` 内部实现。

采集不能依赖本机浏览器。不得提交 `.private/`、`.dev.vars`、OAuth 凭据或会话数据。R2 原始产物保留，派生文本可重建；不要把验证码 HTML 当成功附件。

修改后执行 `pnpm test`、`pnpm build`、`pnpm check:design`、`git diff --check`。UI 修改另外验证真实登录、中文搜索、PDF/下载、双主题与响应式；编译通过不等于业务验收。部署前先应用 D1 迁移；部署与真实账号验证分开记录。
