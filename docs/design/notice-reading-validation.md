# 通知阅读页验证

规格：[Issue #26](https://github.com/cqu-moe/feed/issues/26)，交付切片 #27–#30。采用已批准的 A 布局：正文型 PDF 默认原件、保留正文切换、直接打开所读版本网页快照；共享阅读器覆盖所有既有 PDF 入口。其余全站页面未改版。

## 测试边界

- 浏览器使用实际构建产物、React 路由和 PDF.js；受控数据只位于 HTTP 边界。PDF fixture 包含可选文字、内部链接、120 页横竖混排及不同版本的文件内容。
- Node/Miniflare 验证真实版本读取、原始文件字节、Range/HEAD、权限、未就绪版本隔离和快照净化。
- 遥测单独以虚拟项目标识构建，真实 SDK 的请求全部截获到本地；测试初始化模拟普通浏览器的 webdriver 与可选 client hints，生产逻辑不变。
- 本地受控会话不代表真实 Auth 账号验收；构建与 GitHub CI 不代表 Cloudflare 已部署。

## 复现

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm run ci
pnpm test:browser
VITE_POSTHOG_PROJECT_TOKEN=phc_feed_browser_test pnpm test:browser tests/browser/pdf-telemetry.spec.ts
git diff --check
```

默认使用 Playwright 配套 Chromium。可用 `PLAYWRIGHT_CHANNEL=chrome` 选择本机安装的 Chrome，但仍运行独立无头浏览器，不操作个人浏览器会话。多个工作树使用 `FEED_TEST_PORT` 分配端口；默认 5190。浏览器测试自动构建并启动预览，不复用旧服务。

## 验证记录

实现及审查修复代码 `cfa79b1` 的验证：

| 验证 | 结果 |
| --- | --- |
| Node/Miniflare | 223/223 通过 |
| 浏览器完整阅读流程 | 46/46 通过；2 项遥测按设计另跑 |
| 真实 SDK 遥测 | 2/2 通过；滚轮上下跨页、按钮、缩放不重复记打开，iframe 不记独立打开 |
| 类型、构建、设计、Worker dry-run、差异空白 | 通过 |
| 真实通知 PDF 视觉复验 | 1440/390 像素 × 深浅主题，4/4 通过 |

实际 PDF 视觉复验使用已保存的两页通知原件，外层通知元数据由 HTTP fixture 提供。等待文字层与画布尺寸稳定后检查四组截图：页首完整、原件不反色、整页无横向溢出、初始外层滚动位置保持 0。过早截取画布可见状态会捕获重绘中间帧，不作为最终视觉证据。

## 独立审查

规范与规格两路独立审查共提出五项修正，已集中修复并补充回归：

- PDF 初始定位和按钮翻页只滚动阅读器，不移动外层通知或快照页面。浏览器回归证明初始外层位置保持 0，后续翻页保留用户选择的位置。
- 单页绘制失败进入错误、下载和重试路径。在真实 Canvas 绘制边界触发一次故障，验证原件字节不变、重试后恢复页面并可继续阅读。
- 附件下载链接具有至少 44×44px 的实际触屏区域，并验证靠近底边的触碰可下载。
- 移除共享组件内部选择器覆盖，使用已有外层组合。
- 前端与 Worker 共用有限的噪声清理函数，保留作者、段落和作者附件索引；不增加通用解析器。

修复后由另一位审查者独立复核五项，确认已解决，并以快进方式合入集成分支。真实 PDF 稳定截图同时核对外层位置、页顶对齐、画布尺寸及文字层；未复现中间帧中的空白和裁切。

最终提交及 GitHub CI 状态见 [PR #31](https://github.com/cqu-moe/feed/pull/31/checks)。CI 运行上述完整检查与两组浏览器命令；本地通过和远程通过分别核对。

## 尚未执行的验收层级

本轮没有合并主线、部署 Cloudflare 或使用真实账号验收新版本。原始文件、付费 OCR、采集和推送就绪规则未改动。Vite 保留大于 500 KiB 的分包提示，该提示不影响本轮检查通过。
