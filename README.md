# 应用模板

由设计仓库的 `pnpm create:app <新目录>` 生成后，本目录已经包含 .design/ 下的 theme/ui tarball、相对 file: 依赖和 pnpm override。包尚未发布，不能直接从公共 registry 安装同名包。

```sh
pnpm install
pnpm build
pnpm check:design
pnpm dev
```

访问 http://127.0.0.1:5174。要求 Node.js 22.12+、pnpm 11；修改 package.json 的项目名称和 index.html 的标题。提交 .design/*.tgz、pnpm-workspace.yaml 和生成的 pnpm-lock.yaml，不能只分发个人绝对路径。

如果仅手工复制了 templates/app、尚未生成 tarball，请回到设计仓库按 docs/consumption.md 完成打包和依赖设置再安装。保留 AGENTS.md，安装后从 node_modules/@cqu-moe/ui/dist/START-HERE.md 进入版本化规范。

src/main.tsx 是最小可运行页面：主题、外壳、Lucide 图标、通知和 404 已接入。只从公开包入口添加业务组件；共享 CSS 已编译，仅本应用加载一次 Tailwind reset。生产接口与认证按包内 docs/business-integration.md 接入。
