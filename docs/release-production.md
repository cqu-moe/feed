# 正式发布记录（T18）

2026-10-13，Asia/Shanghai。用户已授权直接正式上线；月费用上限人民币100元。T17真实20:00摘要仍待验收，不以模拟或上线授权代替它。

## 已完成

- Feed暂停配置 `4457eff`：本地203 tests、build、design、Worker dry-run通过；GitHub main CI及Cloudflare构建均成功。CRAWL/TASK_RUNTIME/MAIL/PDF_OCR关闭、Cron为空，版本读取仍走旧入口。
- Auth `bd40fdf`：生产Cloudflare构建 `d0a721f1-7077-46f0-ba58-5d06e8072748`成功；没有待应用迁移。保留既有Auth发件地址和其他子系统配置。
- 已记录两个生产D1的Time Travel恢复点及原在服Worker版本；回执保存在Git忽略的`.private/t18-receipts/`。恢复仅用于事故处置，不倒退投递事实。
- Feed追加迁移0005–0018（实际13个文件）全部成功；原33篇通知均仍为complete并有旧存档前缀。仅查询计数和来源配置，没有将名单或正文导出到本机。
- 正式`feed-jobs/events/mail`及三个同名`-dlq`已创建，消息保留4天；旧`rss-*`资源不复用。
- 现有`cqu-feed`浏览器客户端正常，新增独立后台RPC客户端，只允许`getFeedPolicy`和`getFeedRecipient`；无浏览器redirect/response type/scope。
- 用户指定的生产账号已有已验证邮箱；合并`feed.access=1`和`feed.sub_limit=3`，逐项核对其他权益保持原值，注册默认预设未改。
- Resend正式webhook `https://feed.cqu.moe/webhooks/resend`已创建，监听sent/delivered/bounced/complained；签名secret与新Sending access Key已写入生产Worker。临时Full access Key只用于管理配置，不用于正式发信。

- 原地迁移于09:57完成：33篇ready、33个初始revision、33个history-only事件、189个对象引用，剩余0、差异0、失败0。复用63个附件、18个正文PDF对象及48个既有完整OCR结果，没有重新付费OCR，也未将正文/名单复制到本机。
- 正式Sending Key测试信已受理并于09:54确认delivered。此项只证明供应商邮件通道，不替代应用Queue投递或20:00摘要验收。
- 真实账号已创建“教务处通知”订阅，使用1/3额度、默认每日摘要，私有RSS常驻展示；轮换后旧链接返回404。
- 规则`6a0b906cbe274fe38f3e786bd4768010`已生效；用户明确批准仅GET/HEAD `feed.cqu.moe/rss`及POST `feed.cqu.moe/webhooks/resend`跳过SBFM、BIC及securityLevel，保留WAF、限流、RSS令牌/实时权益和webhook签名校验。

- 外部非浏览器验证：私有RSS 200、8条且均带版本链接；非法令牌404、无签名webhook 400，无Cloudflare挑战。

## 正式启用配置

本次提交开启CRAWL、TASK_RUNTIME、MAIL、PDF_OCR和ARCHIVE_READS；Cron每5分钟推进持久任务与邮件。仅教务处来源启用，刷新间隔24小时，其余四个来源保留配置并暂停。教务处首次发现设为10月14日08:00（北京时间），33篇旧通知按原抓取时间与新旧分级安排未来复查，最早为10月18日11:00:37，不集中立即回查。

启用提交仍须分别记录GitHub CI、Cloudflare构建/在服版本，以及真实账号阅读、中文搜索、PDF/下载、订阅和外部RSS结果；完成证据同步到T18 Issue。T17真实20:00摘要保持独立待验收。

今天旧版已记8次Firecrawl调用，保留原账本，不重置以规避限额。初始正式限制为6次抓取/UTC日、图像OCR2次/UTC日、PDF OCR2源页/UTC日及30源页/UTC月。没有购买或充值；实际增量账单需持续核对，次数限额不是整个Cloudflare/供应商账号100元硬封顶。

## 监控与边界

每日20:10自动检查正式健康、积压、付费调用和20:00摘要，只在状态变化、失败或需处理时通知。T17摘要通过后停止隔离Cron/MAIL并提醒撤销临时Key，正式Sending Key继续保留。异常邮件只由真实签名回执或后台事实核对，不因未知受理结果重发。
