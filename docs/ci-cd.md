# GitHub 与 Cloudflare Git Connector

仓库为私有的 `cqu-moe/feed`。仓库根目录对应本地 `feed/mvp/`，实验目录和其他 worktree 不上传。

## GitHub Actions

`.github/workflows/ci.yml` 在 main push、PR 和手动触发时运行 `pnpm run ci`：测试、TypeScript/Vite/PDF 静态资源构建、设计规范检查和 Worker dry-run。最后一步验证 Wrangler 配置及 Worker 打包，不上传或部署，也不证明远端绑定可用。随后安装 Chromium 并执行 `pnpm test:browser`，失败时保留浏览器截图、trace 和报告 7 天。浏览器测试运行真实构建后的前端与 PDF.js，通过受控 HTTP fixture 提供通知和文件；真实权限、Range/HEAD、版本不可变与快照净化仍由 Miniflare 集成测试验证。只授予 `contents: read`，不配置 Cloudflare secret，不负责部署。

## Cloudflare Workers Builds

在已有 Worker `cqu-feed` 的 Settings → Builds 中连接 GitHub 仓库：

| 设置 | 值 |
| --- | --- |
| Git repository | `cqu-moe/feed` |
| Production branch | `main` |
| Root directory | `/` |
| Build command | `pnpm run ci` |
| Deploy command | `pnpm deploy:ci` |
| Non-production branch builds | 禁用；当前绑定生产 D1/R2/Auth，尚未配置隔离预览环境 |
| Build variable `NODE_VERSION` | `22.22.3`，与 `.nvmrc` 一致 |
| Build variable `PNPM_VERSION` | `11.19.0`，与 `packageManager` 一致 |

2026-10-12 已将上述设置保存到 Worker `cqu-feed`，使用 Cloudflare 自动创建的专用 `cqu-feed build token`。构建环境自动安装依赖；pnpm 使用提交的 lockfile 和 `.design/` 本地包。`pnpm deploy:ci` 先应用远程 D1 迁移，成功后再部署 Worker。构建 token 需要该账号的 Workers Scripts Edit 与 D1 Edit 权限；Worker 绑定的已有 R2、AI、Workflow 和 Auth 资源沿用 `wrangler.jsonc`。

运行时 secrets 留在 Worker 的 Variables and secrets，不复制到 GitHub。Build variables 与 Worker 运行时变量分别管理；Node/pnpm 版本放在 Build variables。

`wrangler.jsonc` 同步保留已有 `feed.cqu.moe` Custom Domain。`BASE_URL` 与 OAuth 回调使用 `https://feed.cqu.moe`；Auth client 必须允许 `https://feed.cqu.moe/auth/callback`。

Auth 的 `cqu-feed` 客户端已同步主页与上述回调；保留原 workers.dev 回调用于旧登录流程完成。两个 origin 的浏览器会话 Cookie 分别保存，迁移域名后需要在新域名重新登录。

日常部署通过提交并 push 到 main 触发 Git Connector。`pnpm deploy` 保留为需要手动部署时的命令，也会先迁移；常规发布使用 Git Connector。

GitHub CI 与 Cloudflare Builds 独立触发，因此 Cloudflare Build command 本身也执行检查。验证分别查看 GitHub CI、对应提交的 Cloudflare build/deployment、线上 `/health` 和实际登录业务；前两者通过不代表真实账号验收完成。

参考：[Workers Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/)、[Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[Build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)。

## 本地浏览器回归

首次运行先执行 `pnpm exec playwright install chromium`，再执行 `pnpm test:browser`。测试会构建前端并启动独立预览服务，不复用已有开发服务器。多 worktree 并行时用 `FEED_TEST_PORT=5191 pnpm test:browser` 指定不同端口。已安装 Chrome 的本地环境也可使用 `PLAYWRIGHT_CHANNEL=chrome pnpm test:browser`，测试仍创建独立无头浏览器上下文。

`pnpm run ci` 保持无浏览器依赖，供 Cloudflare 构建使用。浏览器回归作为 GitHub Actions 的独立步骤执行，不能把 fixture 会话通过当成生产 Auth 登录已验收。
