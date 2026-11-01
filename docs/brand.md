# Feed 品牌标识

Logo 使用用户确认的「通知叠页＋汇聚的信息流」，规范源为 [design PR #6](https://github.com/cqu-moe/design/pull/6) 中 `assets/brand/path-family/feed/`。

- 页面：沿用原始 Logo 几何轮廓，通过 CSS mask 跟随 `--primary` 主题色，固定 32px。已有品牌文字，标识对辅助技术隐藏。
- favicon：`favicon.svg` 随系统主题使用石墨灰 `#222222` / 浅灰 `#dedede`；`favicon.ico` 含 16、32、48px 回退。
- 触屏书签与邮件：`icon-192.png`、`icon-512.png` 由 `logo.svg` 使用 `rsvg-convert` 渲染；BIMI 保持白底与 tiny-ps 格式，标识同步石墨灰。
- `logo.svg` / `logo-dark.svg` 是本项目的主题适配资产，轮廓与设计源相同；黑白版本保留供 mask 和单色使用。
- 首页与 AppShell 使用同一轮廓及主题令牌，品牌文字统一为 CQU Feed。窄屏仍保留完整可访问名称和外观/退出操作。

## 2026-11-02 主题适配

使用 ui / theme 1.1.0 的无彩色调，未修改共享包或增加依赖。仅更新颜色及其光栅导出，几何路径不变。当前视觉方向见 [前端设计决策](frontend-design.md)。

## 验证 · 2026-10-13

在最新 main `5af33af` 上接入，保留账户、订阅和管理员功能。`pnpm run ci` 通过：203 项测试、TypeScript/Vite/PDF 构建、设计规则、Worker dry-run。构建仍有既有大块体积提示。

Ego Chromium 本地假数据：登录入口和通知页面 × 320/390/768/1440 × 双主题，共 16 组；Logo 均正确加载，主题选择正确，顶栏无重叠、页面无横向溢出。另验证与系统相反的页面主题、外观菜单切换、品牌链接键盘焦点。修复了增加 Logo 后窄屏品牌名与用户信息重叠的问题。

使用 ui / theme 1.1.0，没有共享包改动或新增依赖。未访问真实账号或生产业务 API，未验证真实手机、Safari、Firefox；本地假数据验收不代表登录、搜索、PDF 和下载的生产验收。
