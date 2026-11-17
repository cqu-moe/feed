# Modern Web Guidance 检查与优化

检查日期：2026-11-18。基线：`1fec99f`。范围为 Feed 的网页、样式和浏览器交互；用户确认将可验证的前端优化落实到代码。本地模拟接口证据不代表生产账号验收。

## 已落实

| 问题 | 改动 | 验证方式 |
| --- | --- | --- |
| 登录页与通知列表也加载管理页、订阅页和详情的 Markdown 依赖 | 在 `src/main.tsx` 用路由 `lazy` 按需加载这四类页面；鉴权 loader 和错误页继续静态定义，保持数据加载与模块加载并行 | 默认生产构建的首屏脚本从 **854,911 字节降至 584,039 字节，减少 31.7%**；新增 600 kB 首屏脚本预算回归，旧代码失败、优化后通过 |
| 详情页、账户页等始终显示首页浏览器标题 | 各页面使用 `usePageTitle` 更新已有标题，详情跟随实际加载的通知版本，详情及路由错误状态有独立标题 | 在原始提交的独立构建上，详情标题断言失败；修复后中文搜索→详情→后退及 401/403/404 回归通过 |
| 手动采集 ID 不合法时，焦点留在提交按钮；空值时提交按钮被禁用，无法获得校验提示 | 复用 `Input` 的原生 `required` / `pattern` 校验与中文 `setCustomValidity`，显示关联错误；编辑时清除错误，仅在处理中禁用提交，保留提交处理中的原校验 | 空值及非法 ID 不发 POST，浏览器聚焦输入框，辅助技术能取得中文修正说明；修正后 `checkValidity()` 恢复为 true |
| 新建订阅失败后，没有把焦点引向待修正项；名称的错误关联只读出“保存结果未确认” | 聚焦空名称或关注范围字段组，`aria-describedby` 指向具体错误说明；保留既有保存状态和幂等重试 | 空名称与空关注范围不发 POST，焦点和可访问描述正确，编辑名称后旧错误关联消失 |

脚本数字为两端默认生产构建 HTML 直接引用的 script / modulepreload 文件字节总和，包括入口、共享模块和主题脚本；最终匿名登录页面的 Chromium Resource Timing `decodedBodySize` 合计同样为 584,039。Playwright 的测试模式构建另实测为 854,826 → 583,954 字节。以上均非 gzip 传输字节，且未配置生产遥测 token，不包含生产环境可能加载的遥测模块；没有把字节减少换算成实际 LCP/INP 改善。

## 项目指导配置

根 `AGENTS.md` 增加前端任务触发入口，适配规则放在 `docs/agents/modern-web-guidance.md`。Ask Matt 所需的 Issue tracker、五类 triage 标签映射和 single-context 领域文档此前已有配置，继续沿用。

Modern Web Guidance 保持为开发时工具，没有新增运行依赖，也没有增加联网的发布门禁。新增的脚本预算、标题和表单回归复用既有 Playwright 测试与 CI 入口。

## 扫描结果与保留项

`legacy-scan` 本轮检查 38 个指南、52 条确定性规则，只覆盖约 20% 的指南目录；另行读取 `accessibility`、`forms`、`performance`、`js` 和 `defer-rendering-heavy-content`。

- `src/article-detail.tsx` 的复制后排序：按扫描规则的 `dropWhen` 排除。现有 TypeScript `target` / `lib` 为 ES2022，不为一次写法替换升级整项目类型目标或加入 polyfill。
- 全仓补扫还命中 `worker/bailian-projection.mjs`、`worker/subscriptions.mjs` 的数组复制排序，以及 `worker/page-action.mjs` 的桥接 Promise。前两处是后端写法建议，后一处运行在源站采集浏览器；均未证明有产品性能或正确性问题，不纳入本次阅读前端改动。保留源站桥接的握手、超时及 origin/channel 验证。
- 已有 PDF 模块懒加载、窗口化渲染、`ResizeObserver`、滚动帧合并、请求取消、首帧主题脚本和减少动态效果处理，不再重复实现。
- Tailwind 的 `@import` 在构建期展开，不是浏览器串行加载 CSS；不按通用指南机械删除。基础控件继续使用 `@cqu-moe/ui`。

## 后续候选

长篇 OCR 在 `src/ocr-reading.tsx` 一次渲染所有页。可先用大文档测量 Markdown 解析和布局分别占用的时间，再决定是否为确定在首屏之外的重内容块添加 `content-visibility: auto` 与 `contain-intrinsic-size`。该 CSS 不会省去 React/Markdown 解析，应检查滚动位置、浏览器查找和键盘跨页导航；当前没有长文档耗时证据，未直接应用。

## 验证与边界

- `pnpm test`：基线及优化后均为 366 项通过。首次沙箱运行因本机端口 `listen EPERM` 失败，在允许本机监听后重跑通过；最后的空 ID 按钮调整另由下述定向浏览器回归覆盖。
- `pnpm test:browser`：82 项通过，2 项专用遥测测试按配置跳过。随后以本地测试 token 单独运行 `pdf-telemetry.spec.ts`，两项均通过；没有向真实遥测服务发送测试数据。
- 最后的空 ID 按钮调整：先确认旧行为因按钮被禁用而失败，再重跑手动采集文件，4 项通过。
- Firefox / WebKit：登录页、标题导航、管理员鉴权、采集任务和订阅共 46 项通过。临时配置首轮漏设 `baseURL`，部分测试在进入页面前报 Invalid URL；补齐配置后全部重跑通过。
- `pnpm build`、`pnpm check:design`、浏览器测试 TypeScript 检查和 `git diff --check` 通过。
- 已保存 390、768、1440 宽度的浅色/深色登录页截图，抽查移动深色和桌面浅色布局。
- 未部署；真实登录、生产数据、真实设备性能及 VoiceOver/NVDA 播报未在本次验收。PDF.js 独立懒加载包仍超过构建的 500 kB 提示阈值，不属于登录首屏负载。

原始本地证据与复现配置位于忽略提交的 `work/modern-web-guidance/`、`work/modern-web-guidance-accessibility/`。

## Standards

独立审查未发现已证实的规范违反或阻断风险（0 项）；最后的空 ID 校验调整也经补审。鉴权、设计系统、错误语义和幂等保存保持原有责任边界，无新增依赖或持久化状态。测试观察页面行为与加载预算，不增加生产测试接口。

## Spec

独立范围审查无必改项（0 项）。指导配置、四类路由拆包、页面标题和两处表单反馈均落地，长篇 OCR 仍标注为待测候选，未扩大到部署或外部消息发送。两轴结论均以源码、类型和本地证据为限。

## 指南依据

- `performance`：使用动态导入缩小首次加载范围。框架适配参考 [React Router 的 lazy route 文档](https://github.com/remix-run/react-router/blob/main/docs/start/data/route-object.md) 与 [静态 loader 并行规则](https://github.com/remix-run/react-router/blob/main/decisions/0002-lazy-route-modules.md)。
- `accessibility`：每页标题应反映当前内容并随 SPA 导航更新。保留现有单一 `<title>`，避免多个标题并存；相关限制见 [React 的 title 文档](https://react.dev/reference/react-dom/components/title)。
- `forms`：原生校验、中文修正提示、具体错误关联与失败后的焦点引导；不在输入过程中提前报错。
