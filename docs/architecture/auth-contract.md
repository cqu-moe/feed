# Feed 正式版 Auth 契约

状态：2026-10-12 设计稿，未实现、未部署。配套[数据库设计](database.md)与[任务执行设计](orchestration.md)。额度具体数值仍待定。

## 结论与当前代码依据

Auth 只提供 **`feed.access` 与新增的 `feed.sub_limit`**；Feed 保存订阅、栏目范围、RSS 凭证和实际用量。每个订阅一个 RSS，不另加 RSS 数量权益；邮件模式、栏目数和抓取频率首版不增加额外权益键。

现有 `AuthService.getCaps` 保持 `{ calendar } | null` 兼容行为。新增 Feed 专用 RPC，分别查询权限和发信上下文，避免沿用旧接口的 `null` 歧义。网页沿用 OAuth BFF 与当前实时 `feed.access` 检查；后台不用用户浏览器会话。

本次只读核对本地代码：

- Feed 基线 `1ab3b98`，`worker/auth.mjs:509` 登录 scope 无 `email`，`:274` 的 userinfo 映射没有保存验证状态；不能将已有 email 当成当前已验证邮箱。
- Auth 缓存 `origin/main` 为 `02b4f47`，主检出落后 3 个提交；未刷新远端或验证生产。`shared/capabilities.ts:29` 已有 `feed.access`，没有 Feed 数量配额。
- Auth `src/rpc.ts:87` 已有客户端凭证/方法/子系统检查，`:125` 的 getCaps 限定 calendar；Feed 不能直接调用它取得后台权限。
- Auth `src/services/entitlements.ts:12` 的通用解析将缺行、空串和不合法 quota 均折叠成 `null`；写入校验约定空串表示无限。Feed 必须从原始权益行做严格解析，不能从旧 caps 反推缺行。
- Auth `src/db/schema.ts:6` 定义 `email/emailVerified/banned`，`:121` 定义用户权益行。用户身份使用 Auth 稳定 `sub`，不使用邮箱作主键。

## 权益值与配额语义

| 数据库事实 | RPC 表达 | Feed 执行 |
| --- | --- | --- |
| `feed.access` 行值 `"1"` | `access: true` | 允许继续判断对应业务权限 |
| access 缺行或非授予值 | `access: false` | 暂停受保护业务输出，保留配置 |
| sub_limit 合法非负安全整数串 | `{ kind: "limited", value: N }` | 创建配置及运行数量上限 N，0 明确表示零额度 |
| sub_limit 行存在且值为空串 | `{ kind: "unlimited" }` | 明确授予无限；Feed 不自行设置套餐上限 |
| sub_limit 行缺失 | `{ kind: "missing" }` | 创建与运行数量按 0 处理，界面注明未配置 |
| quota 非整数、负数、溢出或其他脏值 | `AUTH_DATA_INVALID` | 拒绝相关新增/输出并保留配置，等待修复 |

新 RPC 不以 `null` 表示配额，更不以网络错误表示无限。旧 calendar 的 null 约定保持不变。`feed.access=true` 且数量为零仍可按现有权限阅读存档，只是不运行个人订阅输出。

创建按**所有未删除订阅配置**计数，用户主动暂停、邮件关闭或 RSS 撤销仍计数；软删除不计数。恢复软删除等同新增配置，走创建数量检查。

运行集合在 `requested_enabled=1` 且未删除的配置中，按 `(priority ASC,created_at ASC,id ASC)` 取额度内部分。默认 priority 一致，即先创建先保留；用户可改变排序。降额保留配置与凭证，只计算为 `quota_exceeded`；恢复后仍有启用意愿的配置自动重新进入运行集合，不打开用户主动关闭的订阅。

暂停原因按通道计算，不持久覆盖用户意愿：`access_revoked / quota_exceeded / auth_unavailable` 可阻止订阅输出；`email_unverified / bounced / complained / mail_off` 只阻止邮件；`rss_revoked` 只阻止该 RSS。邮箱未验证不影响有效 RSS 或网页阅读。

## Feed 执行边界

创建/恢复配置前查新鲜 policy，使用 D1 单条条件 INSERT 或原子 batch 避免并发超额。选择保留哪些订阅、调整排序、主动关闭和删除不是新增配置，不能因“保留配置数已经超额”而禁止这些操作。操作完成后返回配置及计算出的 effective status，明确显示哪些仍暂停。

Auth 与 Feed 无跨库事务：写入前后权益可能变化。成功创建后若复核发现降额或 Auth 故障，保留已创建配置，返回 `created` 加 `effective_status=quota_exceeded/auth_unavailable`；不要返回一个看似完全没创建的通用错误，让重试产生新配置。创建请求使用稳定幂等 ID。

输出前重新核权：RSS 每次读取、邮件每次首次提交、订阅增加能力的操作均查询当前 Auth。一个请求可复用一次返回的上下文；首版不使用跨请求的过期许可继续授权。Auth 不可用返回可重试状态，不能删除配置或按明确撤权永久处理。采集公共来源与已有归档处理不依赖任何订阅用户的 Auth 状态。

授权只能保证查询时点的判断，无法撤回已交给邮件服务商的请求。发送器查询后紧接提交；不承诺“撤权发生同时，已经提交的邮件也立即消失”。对取消/退订等只收紧权限的本地操作，在请求身份可验证的前提下，不额外要求数量权益通过。

## 服务身份与绑定

新增独立 Feed 后台服务客户端，metadata 限定 `subsystem: "feed"`，`rpcMethods` 只允许下述两个方法。使用 Auth 现有客户端 secret 哈希验证；secret 存 Worker secret，不入消息、前端、日志或 R2。网页 OAuth client 不授予后台 RPC 方法。

Feed 新增 `AUTH_FEED_RPC` Service Binding，指向 Auth 当前 Worker 的 **`AuthService` named entrypoint**；现有 `AUTH` HTTP binding 保留用于 OAuth/introspection。不能把现有默认 HTTP entrypoint 当作已经提供新 RPC。

每次调用验证 client 存在、未禁用、secret、方法和 subsystem；再检查目标用户存在且可用。`userId` 仅来自 Feed 已验证会话或数据库订阅归属，不能接受前端自行指定别人的身份。服务身份不会创建用户会话或代发用户 token。

## 两个 typed RPC

以下是 Auth 与 Feed Adapter 之间的传输格式。业务 Module 只调用 `authClient.getPolicy(authSub)` / `getRecipient(authSub)`，由组装好的 Adapter 附加凭证和契约版本；业务代码与测试不自行构造 secret envelope。详见 [Module 与 Interface 设计](modules.md)。

```ts
type FeedAuthRequest = {
  contractVersion: 1;
  clientId: string;
  clientSecret: string;
  userId: string;
};
type FeedPolicy = {
  access: boolean;
  subscriptionLimit:
    | { kind: "limited"; value: number }
    | { kind: "unlimited" }
    | { kind: "missing" };
};
type FeedRecipient =
  | { status: "verified"; email: string }
  | { status: "unverified" }
  | { status: "blocked" }; // access=false，不披露邮箱

type FeedAuthErrorCode =
  | "INVALID_REQUEST" | "UNSUPPORTED_VERSION"
  | "INVALID_CLIENT" | "CLIENT_NOT_ALLOWED"
  | "SUBJECT_UNAVAILABLE" | "AUTH_UNAVAILABLE" | "AUTH_DATA_INVALID";
type FeedAuthResult<T> =
  | { ok: true; contractVersion: 1; checkedAt: number; data: T }
  | { ok: false; code: FeedAuthErrorCode; retryable: boolean; requestId: string };

// 不包含邮箱，用于订阅管理与 RSS。
declare function getFeedPolicy(req: FeedAuthRequest): Promise<FeedAuthResult<FeedPolicy>>;

// 同一次查询返回权限与邮件地址，发送器不用先后拼接两个响应。
declare function getFeedRecipient(req: FeedAuthRequest): Promise<FeedAuthResult<{
  policy: FeedPolicy;
  recipient: FeedRecipient;
}>>;
```

Auth 在一次一致的数据库读取中取得用户状态、Feed 两个权益行及邮件查询所需字段，然后构造响应。`checkedAt` 是查询时间，不是有效期承诺或可长期缓存的授权票据。以后不兼容形状变更增加 contractVersion，未知版本明确拒绝。

`getFeedRecipient` 仅在用户有效、access 为真、当前 `emailVerified=true` 时返回当前 `user.email`；未验证不返回地址，access 为假返回 blocked。邮箱脏数据返回 AUTH_DATA_INVALID，不能猜测或降级成另一个邮箱。该方法返回 policy，使发送器同时判断订阅运行集合。

两接口只披露 Feed 字段，不返回其他子系统 caps、用户浏览器会话、封禁原因、待验证邮箱、验证码或账户绑定。邮件地址只用于准备/核验投递快照，Feed 不建立第二个可编辑的用户主邮箱。

| 结果 | Feed 处理 |
| --- | --- |
| `ok=true, access=false` | 已确认缺少 Feed 权益，保留配置并暂停输出 |
| `INVALID_REQUEST / UNSUPPORTED_VERSION` | 修正调用或版本，不重试同一坏请求 |
| `INVALID_CLIENT / CLIENT_NOT_ALLOWED` | 服务配置故障，记录运维错误，不能把所有用户标为撤权 |
| `SUBJECT_UNAVAILABLE` | 用户不存在/被禁用等，统一拒绝，不披露细分原因；保留可恢复配置 |
| `AUTH_UNAVAILABLE` 或 transport timeout/exception | adapter 统一为可重试不可用，延期、不删除 |
| `AUTH_DATA_INVALID` | 等待 Auth 数据修复，保留配置，不使用旧无限语义 |

只有暂时不可用设置 `retryable=true`。其他结果停止自动快速重试，但修复服务配置、用户状态或脏数据后仍可通过 reconciliation 恢复。错误不返回内部 SQL、堆栈或 secret。

## RSS 与邮件的对外表现

订阅设置仅向当前已验证会话的所有者返回解密后的当前 RSS 链接，允许持续查看和复制；RSS 读取仍先验证 token hash，再按 owner 查询 policy 和运行集合。无效、已轮换或撤销 token 返回 404；有效 token 但明确权益/配额暂停返回 403；Auth 暂不可用返回 503 + Retry-After。响应 `Cache-Control: private, no-store`，不通过公开 CDN 缓存绕开实时权限。暂停不发送 410，避免阅读器把可恢复订阅永久移除。

正常 RSS 只包含日期已核实、完整事件的标题、摘要和版本链接；附件不提供公开对象地址。ETag 可以用于客户端条件读取，但先完成权限检查再考虑 304。正文和文件路由继续登录并检查 `feed.access`。

邮件准备可提前做，首次提交前必须调用 getFeedRecipient；未验证只暂停邮件。未提交消息的邮箱/内容可以通过取消后重建刷新；已可能提交的消息必须复用原始请求核对结果，不能同一幂等键更换地址。退出邮件、退信或投诉保持与 Auth 邮箱验证独立。

## 兼容迁移与验收

1. Auth 增加能力目录键、严格解析与两个新 RPC；管理台清楚区分缺行、数字和空串无限。保留 calendar/getCaps/verifySession 的既有契约，加入回归测试。
2. 新 sub_limit 不经通用 quota 解析外泄到 Feed 旧 OAuth 路径；Feed claims/introspection 继续只提供既有 `feed.access`。网页主邮箱获取不依赖扩大登录 scope，发信使用服务 RPC。
3. 配置 named binding 和独立 service client 后，Feed 先接入只读 policy/recipient 验证；确认旧登录和存档访问兼容。
4. 新订阅功能开放前明确各用户/预设的额度，缺失额度不隐式授权；用户仍可保留原有 feed.access 阅读存档。
5. 启用订阅条件写入、运行集合、RSS 和邮件发送前校验；分开验证 Auth 发布、Feed 发布、真实账号行为。旧网页回滚不依赖删除新能力键。

验收矩阵包括缺行/0/正数/无限/脏值；错误客户端与真实用户撤权的区分；被禁用户；Auth 超时；已验证邮箱修改；降额后重新排序；配额恢复不打开主动停用项；邮箱未验证仍可读取有效 RSS；并发创建、写后降额与结果幂等。接口尚未实现，本轮没有对生产 Auth 发起这些验证。
