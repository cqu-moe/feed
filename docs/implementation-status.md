# 正式版实现与验收记录

更新：2026-10-12（北京时间）。总规格 [#1](https://github.com/cqu-moe/feed/issues/1)，完整任务图见[实现计划](specs/feed-production-plan.md)。

## 集成基线

- Feed：`feat/production-v1`，从 MVP `1ab3b98` 建立；已批准规格提交 `2f87147`。
- Auth：配套集成分支 `feat/feed-production-v1`，从 `origin/main` 的 `02b4f47` 建立。跨仓库契约由 T02 一起验收。
- 每个任务使用独立 worktree；实现分支先合入最新集成分支，再由独立合并代理审查并合入集成。
- 本地测试、隔离云环境交接、真实账号与供应商行为、生产灰度分别记录。完成一层不能代替后一层。

## 当前进度

| 任务 | 状态 | 交付依据 |
| --- | --- | --- |
| T01 / #2 | 本地验收完成 | 签名提交 `91c2d1c`；24 项测试、构建与设计检查通过，独立审查通过 |
| T02 / #3 | 本地验收完成 | Feed `eee13e0`，Auth `f66e2dd`；独立审查后快进合入两条集成分支。Feed 27 tests/build/design 与 Auth check:ci（896 unit / 393 DO）通过；账户 UI 7 种状态及窄屏双主题检查通过（API fixture） |
| T03 / #4 | 本地验收完成 | 签名提交 `25dfbb3`，合并态 `fc45830`；40 项测试/build/design 通过，独立审查并快进合入。管理 UI 故障重试、凭据清理与双主题检查通过（API fixture） |
| T04 / #5 | 本地验收完成 | 签名提交 `924fe6e`，独立审查后快进合入；与 T05 集成的52项测试/build/design 通过。覆盖同域独立站点、请求重放、列表 R2 复用、跨栏目版本读取；管理页双主题/响应式与失败重试检查通过 |
| T05 / #6 | 本地验收完成 | 签名提交 `8c02889`，独立审查后快进合入；44 项测试/build/design、Worker dry-run 和版本历史/PDF 浏览器验收通过 |
| T06 / #7 | 本地验收完成 | 签名实现 `8b98461`，集成 `4239b4a`；67项测试/build/design 与独立审查通过。实际 Worker Queue/BFF 验证完整发布、R2/D1重放付费调用复用；多PDF连续/并发重做保留改进且冻结历史，阅读与管理UI已验收 |
| T07 / #8 | 本地验收完成 | 签名实现 `37472bb`、布局修复 `949af64`，集成 `c4ba319`；62 项测试/build/design、独立审查及 320/390/768/1440 布局检查通过，持续 RSS 展示/复制、重试、配额故障状态已验收 |
| T08 / #9 | 本地验收完成 | 签名实现 `c0bbc9a`；77 项测试/build/design/Worker dry-run 通过，独立审查并快进合入。覆盖编辑、运行集合、删除恢复、RSS 轮换撤销、丢响应重放及同毫秒栏目快照；双主题响应式 UI 已验收 |
| T09 / #10 | 本地验收完成 | 签名修复 `16a34e6`；79 项测试/build/design/Worker dry-run，独立 RSS＋订阅回归 12/12 通过并快进合入；XML、历史版本链接、持续复制、轮换撤销、条件读取权限及双主题响应式已验收 |
| T10 / #11 | 本地验收完成 | 签名提交 `06946fb`，独立审查并快进合入；97 项测试/build/design/Worker dry-run 通过，独立聚焦 21/21 与回归 3/3 通过。来源/ready 并发交接、日期撤回、恢复积压、权益撤销读边界及双主题响应式 UI 已验收 |
| T16 / #17 | 本地验收完成 | 实现 `5cb75fc`、证据保留修复 `c83852b`，集成 `e345f94`；与 T09 合并的 86 项测试/build/design/Worker dry-run 通过，独立增量审查通过。覆盖不可变导入、OCR 身份/页数、缺项恢复、逐项比对、中文搜索、权限和切读回滚；未运行生产迁移 |
| T11 / #12 | 本地验收完成 | 签名实现 `0e16f70`，签名集成 `e0e1a06`；119 项测试/build/design/Worker dry-run 通过，独立聚焦22/22、竞态回归2/2通过。不可变邮件、Resend Adapter、签名回执、结果不明对账、退信提交屏障及有界恢复已验收；用户/管理页面双主题响应式已验收 |
| T12 / #13 | 本地验收完成 | `06e1594`，独立复审 PASS 后签名合并 `35abb3f`；127 tests/build/design/dry-run 通过，实际 Worker 摘要及双主题移动端 UI 验收通过 |
| T13 / #14 | 本地验收完成 | 签名候选 `82e0cdc`，独立复审 PASS 后签名合并 `c34a600`；134 tests/build/design/dry-run 通过，独立 6 项回归及 7 项游标、并发与控制探针通过。全部存档分级复查、暂停与配置屏障、共享栏目及有界扫描公平性已验收 |
| T14–T15、T17–T18 | 实现或等待依赖 | T14–T15 已实现，正在独立审查与修复；未声称云端或生产验收完成 |

## 会话中的规格调整

已确认的远端检查：[Feed CI](https://github.com/cqu-moe/feed/actions/runs/38246894256) 对应 T09/T16 记录提交 `fb2d1f5`；[Auth CI](https://github.com/cqu-moe/auth/actions/runs/38204211719) 对应 `f66e2dd`。T10 [Feed CI](https://github.com/cqu-moe/feed/actions/runs/38256233596) 对应 `90b0002`、T11 [Feed CI](https://github.com/cqu-moe/feed/actions/runs/38264557197) 对应 `f72773f`、T12 [Feed CI](https://github.com/cqu-moe/feed/actions/runs/38270907608) 对应 `260f803` 均已成功；T13 的远端检查须按新提交单独确认。以上均不代表生产部署。

- 2026-10-12：用户确认私有 RSS 链接可以持续展示。订阅所有者登录后可随时查看和复制；以加密保存凭证支持取回，保留 hash 校验及独立轮换/撤销。此决定替换旧的一次性展示约定，已同步 T07/T08 规格。

## 云端前置配置与核对

- 当前 `cqu-feed` 仍有 MVP 的 `FeedIngest`、`PdfOcrWorkflow`；尚无正式版三条业务 Queue 及配套 DLQ。旧 `rss-*` 资源归属未在此任务中确认，不复用。
- 当前 Git Connector 仅部署 main，非生产分支构建关闭。隔离验收必须显式使用独立 D1、R2、Queue、Workflow、Auth 客户端与邮件配置。
- 仅查询密钥名称，未读取值：用户配置后已确认 `cqu-feed` 存在 `FIRECRAWL_API_KEY`。未读取密钥值；供应商有效性和正式任务调用仍待云端验收。
- 当前 Feed 没有新的后台 Auth RPC 客户端或邮件服务密钥。不得把 OAuth 浏览器客户端直接当后台服务身份。
- 首版邮件供应商已由用户确定为 Resend，要求后期可替换；决定见 [T11 选型记录](https://github.com/cqu-moe/feed/issues/12#issuecomment-6117297565)。独立 Adapter 负责供应商 API 和 webhook 协议，Notifications 保留业务去重、快照与恢复规则。
- 隔离验收收件人已获用户授权；Resend 已创建专用发件域 `feed.cqu.moe`，四条 DNS 记录已在 Cloudflare 保存（DNS only，TTL 300），Resend 已确认域和四条记录全部 verified。隔离云端验收总费用上限已由用户确认为人民币 50 元，覆盖抓取、OCR、邮件和新增 Cloudflare 资源；正式权益默认值及生产预算仍待确定。未确定的条件不阻止不依赖它们的代码实现，但不能用 mock 关闭云端验收任务。

已向用户指定的验收邮箱发送一封发件域测试邮件，Resend 返回 `delivered`（收件服务器已接收）。本次通过 Resend Connector 验证供应商通路，不经过 Feed Queue，不作为 T11/T17 的应用内投递验收。

此文件随实际合并和验证更新；未部署正式版，未迁移生产数据。
