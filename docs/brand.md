# Feed 品牌标识

Logo 使用用户确认的「通知叠页＋汇聚的信息流」，规范源为 [design PR #6](https://github.com/cqu-moe/design/pull/6) 中 `assets/brand/path-family/feed/`。

- 页面：`logo-black.svg` / `logo-white.svg`，跟随根节点 `data-theme`，固定 32px。已有品牌文字，图片使用空 alt。
- favicon：彩色 `favicon.svg`，随系统浅深主题选择莓红 / 浅莓红；`favicon.ico` 含 16、32、48px 回退。
- 触屏书签：`icon-192.png`。素材来自 design 同步脚本，8 个文件逐项 SHA-256 一致。
- 登录入口与 AppShell 使用同一个 FeedBrand；窄屏品牌名称与用户名允许省略，保留完整可访问文字与退出/外观操作。

## 验证 · 2026-10-13

在最新 main `5af33af` 上接入，保留账户、订阅和管理员功能。`pnpm run ci` 通过：203 项测试、TypeScript/Vite/PDF 构建、设计规则、Worker dry-run。构建仍有既有大块体积提示。

Ego Chromium 本地假数据：登录入口和通知页面 × 320/390/768/1440 × 双主题，共 16 组；Logo 均正确加载，主题选择正确，顶栏无重叠、页面无横向溢出。另验证与系统相反的页面主题、外观菜单切换、品牌链接键盘焦点。修复了增加 Logo 后窄屏品牌名与用户信息重叠的问题。

使用 ui / theme 1.1.0，没有共享包改动或新增依赖。未访问真实账号或生产业务 API，未验证真实手机、Safari、Firefox；本地假数据验收不代表登录、搜索、PDF 和下载的生产验收。
