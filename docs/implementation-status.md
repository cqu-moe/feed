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
| T01 / #2 | 实现中 | 独立分支 `impl/feed-t01` |
| T02 / #3 | 实现中 | Feed `impl/feed-t02`，Auth `impl/feed-policy-t02` |
| T03–T18 / #4–#19 | 等待各自依赖 | 未声称实现或验收完成 |

## 云端前置条件的只读核对

- 当前 `cqu-feed` 仍有 MVP 的 `FeedIngest`、`PdfOcrWorkflow`；尚无正式版三条业务 Queue 及配套 DLQ。旧 `rss-*` 资源归属未在此任务中确认，不复用。
- 当前 Git Connector 仅部署 main，非生产分支构建关闭。隔离验收必须显式使用独立 D1、R2、Queue、Workflow、Auth 客户端与邮件配置。
- 仅查询密钥名称，未读取值：当前 Feed 没有 `FIRECRAWL_API_KEY`，与 MVP 运维文档记录的 keyless 入口一致。正式付费抓取凭据仍需明确配置。
- 当前 Feed 没有新的后台 Auth RPC 客户端或邮件服务密钥。不得把 OAuth 浏览器客户端直接当后台服务身份。
- 首版邮件供应商已由用户确定为 Resend，要求后期可替换；决定见 [T11 选型记录](https://github.com/cqu-moe/feed/issues/12#issuecomment-6117297565)。独立 Adapter 负责供应商 API 和 webhook 协议，Notifications 保留业务去重、快照与恢复规则。
- 隔离验收收件人、已验证发件域、正式权益默认值和费用上限尚待确定；这些条件不阻止不依赖它们的代码实现，但不能用 mock 关闭云端验收任务。

此文件随实际合并和验证更新；未部署正式版，未迁移生产数据，未发送验收邮件。
