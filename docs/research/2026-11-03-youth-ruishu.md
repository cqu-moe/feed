# Issue #61：校团委正文入口与瑞数验证

调研日期：2026-11-03（北京时间）。问题来源：[issue #61](https://github.com/cqu-moe/feed/issues/61)。Feed 基线为 `bddaec9b79b8ef6b488b0cea043ecd74c31e66d4`；Auth 对照为本地 `e81c7be18a3855efc3e58fd6b6782682078b4186`。本文区分源码事实、本轮实验和尚未确定的防护原因。

## 结论与修复

同一 APAC Cloudflare 容器中，公开链接 `/info/1009/25310.htm` 的主文档为 **412 → 403**；使用 issue 中普通浏览器已经到达的官方 `/content.jsp?urltype=news.NewsContentUrl&wbtreeid=1009&wbnewsid=25310`，则为 **412 → 200**，实际标题、正文 PDF、离线原貌与截图均可保存。两条路径仍由正常浏览器执行源站验证，不能把这个结果描述为关闭防护，也不能据此确定瑞数版本、具体拒绝规则或 IP 封禁原因。

修复只在发送浏览器任务时，将 `https://youth.cqu.edu.cn/info/1009/<数字>.htm` 解析为对应官方正文入口；文章 URL、文章 ID、任务、来源及原始页面动作保持原身份。列表、其他栏目和其他站点继续使用原 URL。样本验证接受这两个入口的同一文章，仍拒绝不同文章编号和不同 origin。实现见 [source-url.mjs](../../worker/source-url.mjs)、[browser-scrape.mjs](../../worker/browser-scrape.mjs)、[source-validation.mjs](../../worker/source-validation.mjs)。

## 与 Auth 的源码对照

| 项目 | 当前事实与适用边界 |
| --- | --- |
| Chrome | Auth 和 Feed 均固定 Chrome for Testing `148.0.7778.96`，下载校验 SHA-256 相同；均通过 Xvfb 运行。见 [Auth Dockerfile](https://github.com/cqu-moe/auth/blob/e81c7be18a3855efc3e58fd6b6782682078b4186/container/Dockerfile#L44-L56)、[Feed Dockerfile](../../crawler/Dockerfile)。 |
| 启动 | 两者使用临时 profile、非零回环 CDP 端口、`--no-first-run`、`--no-default-browser-check`、`--no-sandbox`、`--disable-dev-shm-usage`。Auth 有 DISPLAY 时使用窗口模式；Feed 另有验证码辅助窗口所需的 `--disable-popup-blocking`。Auth 当前启动函数没有额外 GPU、后台计时或自动化隐藏开关。见 [Auth build_chrome_args](https://github.com/cqu-moe/auth/blob/e81c7be18a3855efc3e58fd6b6782682078b4186/container/chromium_session.py#L28-L50)、[Feed 浏览器](../../crawler/browser.mjs)。 |
| CDP 与语言 | 两者均启用 Page/Network，并使用中文 Preferences、locale 与上海时区；均不调用 `Runtime.enable`。Auth 另外启用 DOMStorage 并设置 1440×900 viewport。见 [Auth 初始化](https://github.com/cqu-moe/auth/blob/e81c7be18a3855efc3e58fd6b6782682078b4186/container/chromium_session.py#L303-L342)、[Feed 初始化](../../crawler/browser.mjs)。 |
| 等待 | Auth 登录流程也会轮询页面；不能把“完全不执行 evaluate”当成 Auth 的必要条件。它等待登录表单与动态状态就绪；Feed 等待主文档 2xx 与正文可用，公开通知不需要导入学校账户状态。见 [Auth 登录等待](https://github.com/cqu-moe/auth/blob/e81c7be18a3855efc3e58fd6b6782682078b4186/container/cqu_login_cdp.py#L29-L56)、[Feed 就绪检查](../../crawler/scrape.mjs)。 |
| 重载与预算 | Auth 的封装提供普通 `Page.reload`，Cloudflare profile 使用较宽的有界等待。存在该 API 不证明“403 后刷新”能修复 Youth。本轮同页再次导航仍为 403。见 [Auth 导航](https://github.com/cqu-moe/auth/blob/e81c7be18a3855efc3e58fd6b6782682078b4186/container/chromium_session.py#L419-L433)、[时间预算](https://github.com/cqu-moe/auth/blob/e81c7be18a3855efc3e58fd6b6782682078b4186/container/browser_profile.py#L14-L48)。 |
| 源站资源 | Auth 取票放行 SSO 自身资源；Feed 为已知 VSB 解析停滞屏蔽统计脚本。移除这项屏蔽没有修复 Youth 正文 403，故不扩大改动。见 [Auth 请求范围](https://github.com/cqu-moe/auth/blob/e81c7be18a3855efc3e58fd6b6782682078b4186/container/cqu_ticket_browser.py#L68-L79)、[Feed 屏蔽规则](../../crawler/browser.mjs)。 |

Feed 已采用 Auth 的核心临时浏览器方案；本轮有效差异是官方正文入口，而非新增长期会话、代理、令牌提取或改变任务尝试上限。

## 本轮实验

独立 Worker 为 `cqu-feed-issue61-probe-20261103`，单容器、basic、APAC，无生产 D1/R2/Auth 绑定，访问密钥单独设置。生产镜像 digest 为 `ce21ababe524b94a40e6256a6b71ea73fee4162676d61c79151195e340eabfe2`。先原样复用该镜像确认失败，再使用相同 Chrome 的实验镜像逐项对照；实验开关仅位于 Git 忽略的 `work/cloud/`。

| 环境/变更 | 结果 | 证据 |
| --- | --- | --- |
| 本地 Linux/amd64，生产采集代码，25310/25311 | 原 `/info` 页面可正常取得；实际 PDF、离线 HTML、截图保存成功。25310 观察到 412 → 200，且没有 `/content.jsp` 跳转。 | `work/local-acceptance.json`、`work/evidence/full/` |
| 云端完全相同生产镜像，25310/25311 | 均约 131–134 秒后报告主文档 403。 | `work/cloud/results.jsonl` |
| 首次导航后独立等待 8 秒再轮询 | `/info`：412 → 403。 | `work/cloud/variants.jsonl` |
| 403 后在同一临时浏览器再导航一次原 URL | `/info`：412 → 403 → 403。该实验使用 `Page.navigate`，不宣称等同于另测 `Page.reload`。 | 同上 |
| 先打开官方列表，等待 10 秒，再导航正文 | 列表 412 → 200；正文仍 403。该实验不是 DOM 点击对照，不能证明点击行为没有差异。 | 同上 |
| 不屏蔽 counter.js/dynclicks.js | 补跑后 `/info`：412 → 403。首次实验遇到本地验收交接导致的容器 503，未计为源站结果。 | `work/cloud/route-counter.jsonl` |
| 同一云端环境改用官方 `/content.jsp` | 412 → 200，真实标题与 PDF、snapshot.html、offline.html、截图均保存，页面动作 errors 为空。 | 同上、`work/evidence/cloud/25310-wrapper/` |
| 最终实际 Worker 适配器，输入 25305–25312 的原始 `/info` URL | 8/8 取得真实正文、snapshot.html、offline.html 与截图，页面动作 errors 均为空。7 篇保存 PDF 原文件；25305 是 1,160 字 HTML 正文，无附件。 | `work/cloud/final-acceptance.jsonl`、`work/cloud/seven-pdf-verification.json`、`work/cloud/html-only-acceptance.jsonl` |

25310 PDF 为 317,490 字节，SHA-256 `371fdd42c112541325435bd64dae7d297980ee8f3126056e6c264a6360bc23e7`；云端官方正文入口与本地原链接所得字节相同。25311 本地 PDF 为 161,869 字节，SHA-256 `c67e197babaa5636ce89782494b9459504d161512e659f5c6245b1c779353572`。截图中的源站 PDF 画布尚未完成可视呈现，因此以下载文件签名、长度与哈希验证 PDF，不用截图宣称其已完整渲染。

## 回归与诊断

- [真实 Chrome 回归](../../crawler/browser.test.mjs)覆盖 HTTP 302 → JavaScript → `/content.jsp`，以及 PDF 子框架 403 不影响主文档状态；已有浏览器行为不是本次失败原因。
- 源站错误现在携带最终主文档 pathname（最多 80 字符）与末 6 个主文档状态，不含 query、fragment、Cookie 或令牌。重定向后 404 的新回归先在旧代码上因缺少诊断失败，再在改动后通过。
- [适配器回归](../../tests/browser-worker.test.mjs)在旧代码上因仍发送 `/info` 而失败；[样本验证回归](../../tests/source-validation.test.mjs)在旧代码上因拒绝等价官方入口失败。修复后二者通过，且不同文章与跨 origin 负例仍拒绝。
- 最终代码的 `pnpm run ci` 通过：271 项测试、构建、设计检查和 Worker/容器 dry-run；独立真实 Chrome 7/7，通过格式整理后的适配器与样本验证回归 9/9。隔离云端另覆盖上述 8 篇真实通知。最初验收脚本误把每篇都必须带 PDF 作为成功条件，已改为按真实附件需求检查；纯 HTML 的 25305 单独复核通过，没有隐藏失败退出码。
- CDP 对主框架的区分依据 `frameId`；HTTP redirect 响应另由 requestWillBeSent.redirectResponse 表达，因此诊断中的状态序列只声称记录主文档 responseReceived，不声称列出所有 HTTP 3xx。参见 [官方 Network 协议](https://chromedevtools.github.io/devtools-protocol/tot/Network/)、[官方 Page 协议](https://chromedevtools.github.io/devtools-protocol/tot/Page/)。

## 生产与边界

本轮只读 D1 快照确认 25305–25312 的 8 个旧 capture 任务仍为 blocked、attempt_no=3；没有重置、清空错误或自动重跑。隔离验收成功不等于这些旧任务已在生产完成，也不证明站点未来不会调整路径或防护规则。实际归档截图已保存，但原生 PDF 画布的视觉呈现与阅读端真实账号验收不在本轮恢复证明中。临时 Worker、单容器应用和新建镜像 tag `611e90d0` 已清理；生产资源和生产镜像保留。

按 research 技能尝试启动的 GLM-5.3/max 调研代理及默认路由代理均因账户周/月额度耗尽退出；上述源码对照由主代理直接完成，没有把失败代理描述为已完成研究。
