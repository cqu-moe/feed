# Feed Auth 接入实现说明

本 worktree 采用机密 OAuth client + feed 独立 BFF 会话 + 每次受保护请求实时 introspection。当前依赖已包含 `jose@6.1.3`，没有安装 `oauth4webapi`；本实现不需要新增依赖，ID token/JWKS 使用 `jose`，OAuth 表单请求使用标准 `fetch`。

## 模块契约

`worker/auth.mjs` 导出：

- `session(request, env)`：无本地会话返回 `{ authenticated:false, entitled:false }`；本地已登录但 Auth 权益缺失返回 `{ authenticated:true, entitled:false, user, error:"access_denied" }`，父路由应映射 403；Auth/DB 故障或并发刷新等待时返回 `error:"unavailable"`，父路由应 fail closed 并映射 503；本地 token 被撤销或刷新失败则删除本地会话并返回未认证。
- `authRoute(request, env)`：处理 `GET /auth/login`、`GET /auth/callback`、`POST /auth/logout`（同时兼容 `/api/auth/*`），其余路径返回 `null`。

配置优先使用当前 `BASE_URL`、`AUTH_BASE_URL`，同时兼容 `PUBLIC_URL`、`AUTH_ORIGIN`；client 与加密配置优先 `FEED_AUTH_CLIENT_ID`、`FEED_AUTH_CLIENT_SECRET`、`FEED_SESSION_ENCRYPTION_KEY`，并兼容 `AUTH_CLIENT_ID`、`AUTH_CLIENT_SECRET`、`SESSION_ENCRYPTION_KEY`。所有 secret 必须通过 Workers secrets 注入。

## 存储与安全

`migrations/0002_auth.sql` 会删除未使用的 `sessions`、`oauth_states`，建立：

- `feed_login(state_hash, browser_hash, payload, expires_at)`：OAuth state、浏览器事务绑定值只存 SHA-256 哈希；PKCE verifier、nonce、returnTo 加密在 `payload`。
- `feed_session(token_hash, payload, expires_at, revision, refresh_until)`：应用 cookie 只存 SHA-256 哈希；access/refresh token、用户信息加密在 `payload`；绝对会话 7 天，`revision`/`refresh_until` 用 CAS 避免 refresh token 重放。

cookie 为 host-only `__Host-feed_session` 与 `__Host-feed_login`，均 `Secure; HttpOnly; SameSite=Lax; Path=/`，不设置 `Domain`。本地 logout 只删除 feed 会话，不撤销 auth.cqu.moe 中央登录。

ID token 校验 issuer、audience、EdDSA 签名、nonce 和 `sub`，userinfo 必须与 `sub` 一致。每次受保护请求都会 introspection access token，并验证 `active`、精确 `client_id`、相同 `sub`、非空 `sid`、未来 `exp` 与 `caps.feed.access === true`。权益不做正向缓存，因此 Auth 侧撤销在下一次请求生效。

## Auth 与部署前置

Auth 侧最小改动是在能力目录加入 `feed.access` 并部署；无需 Auth D1 migration。注册机密 OAuth client 时使用回调 `https://<feed-origin>/auth/callback`，`token_endpoint_auth_method=client_secret_basic`，scope `openid profile offline_access`，并设置 `metadata.subsystem="feed"`、`skip_consent=true`。生产 Worker 需要三个 secrets：`FEED_AUTH_CLIENT_ID`、`FEED_AUTH_CLIENT_SECRET`、`FEED_SESSION_ENCRYPTION_KEY`。

若配置 `AUTH` service binding，OAuth token/userinfo/introspection/JWKS 请求会优先走 Auth Worker 默认 HTTP entrypoint；否则走公网 HTTPS。service binding 不需要指定 `AuthService` RPC entrypoint。

## 父路由集成要求

所有内容出口必须先调用 `session()` 并同时要求 `authenticated && entitled`，包括列表、搜索、详情、HTML 快照、截图、附件、下载和已替换的保存 PDF 预览。`error:"unavailable"` 应返回 503；`authenticated:true && entitled:false` 应返回 403；未认证返回 401。原貌 HTML 中的 PDF frame 应替换为 feed 自己的受保护 PDF 路由，不能保留源站未鉴权 URL。
