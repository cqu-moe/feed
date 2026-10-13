# 正式发布记录（T18）

2026-10-13，Asia/Shanghai。用户已授权直接正式上线；月费用上限人民币100元。T17真实20:00摘要已于20:01送达并由用户截图、真实签名回执和投递账本核对通过，详见[隔离验收记录](acceptance-production.md)。

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

启用提交的GitHub CI、Cloudflare构建/在服版本，以及真实账号阅读、中文搜索、PDF/下载、订阅和外部RSS结果已分别记录于下节；完成证据同步到T18 Issue。T17真实20:00摘要已独立验收通过。

今天旧版已记8次Firecrawl调用，保留原账本，不重置以规避限额。初始正式限制为6次抓取/UTC日、图像OCR2次/UTC日、PDF OCR2源页/UTC日及30源页/UTC月。没有购买或充值；实际增量账单需持续核对，次数限额不是整个Cloudflare/供应商账号100元硬封顶。

## 上线后验证（10:30起）

- Feed启用提交 `d04c0b69627794396a3cb9ddf105d673c39e16c8`：[GitHub CI 38336924479](https://github.com/cqu-moe/feed/actions/runs/38336924479)成功；Cloudflare构建 `8ab8da36-65ed-44d2-8b21-9e34d5196c8c`成功；在服版本 `5dd460a3-2255-4f86-8015-e81b4424c4ee`，部署 `b48f2bce-e9c3-438c-a50d-4a4d5d804318`。从Worker设置读回5个Workflow、3个Queue producer及所有正式功能开关为true；Cron为每5分钟。
- 真实账号：health 200，Auth可用/邮箱已验证/额度3；列表33篇、中文“招聘”搜索1篇；指定通知版本ready、时间线1条、正文可读。该公开通知的版本快照、截图和DOC下载均200，附件74,752字节。另一篇4页PDF在阅读器实际渲染，Range返回206、PDF签名正确。
- RSS上线后复验200/8条，HEAD 200、ETag条件请求304；未登录业务API 401。
- 正式邮件已启用；10:32应用邮件台账0条、unknown 0、Auth不可用0、必要缺项0。随后通过管理员正常recover分批派发，33条历史事件和33个匹配任务全部完成，66条真实Queue回执均processed；最终delivery 0、message 0、queued outbox 0，未误发历史邮件。
- 首次正式源站抓取与完整生产20:00摘要窗口尚未观察；不扩大来源/用户范围。生产恢复点已保留，隔离读取回退已验证，生产回滚演练仍未记作完成，T18 Issue保持开放。

## 监控与边界

每日08:10及20:10自动检查正式健康、积压、付费调用和20:00摘要，只在状态变化、失败或需处理时通知。T17摘要已通过，隔离Cron/MAIL已读回确认关闭，提醒撤销临时Key，正式Sending Key继续保留。异常邮件只由真实签名回执或后台事实核对，不因未知受理结果重发。

## 晚间生产监控（21:42–21:45）

- 正式健康200，私有RSS 200且仍有8条，实时Auth读取可用；正式功能开关和每5分钟Cron保持开启。当前在服版本`2ebce40e-a7b3-4da6-98e8-b0d7901cf9c7`、部署`c65e4705-b49a-4b4c-abd4-6b533210c537`。另外核对品牌更新`cb16fae`的[GitHub CI](https://github.com/cqu-moe/feed/actions/runs/38346751359)和Cloudflare构建`f7f712d2-8be3-4065-b024-8d1291ad8e89`均为success。
- 待处理任务、缺项、死信、未知邮件和Auth不可用均为0；66条Queue回执processed，33个事件均history-only。正式邮件和delivery均0、重复0，没有20:00摘要窗口记录，符合没有新增候选时不发空摘要；不据此宣称正式新通知投递已验收。
- 仅教务处启用，首次发现仍为10月14日08:00；旧版08:01的无链接/分页未完成错误尚未被新任务覆盖，不记作本轮新增失败。Firecrawl当日仍8次、累计付费调用104；OCR月已处理17页、月预留19页，当日已处理1页、预留3页，均未增加，不重置旧账本。
- Cloudflare从10:30正式启用至21:44的可见增量：Feed请求418、已上报errors 0；feed-events计费操作182，其余正式Queue未返回操作行；R2 PutObject 2、GetObject 19、HeadObject 9、HeadBucket 4。21:30存储快照905对象、payload 346,200,020字节，包含既有存档。正式D1当日读取54,659行、写入4,528行，UTC日口径包含上线前活动，不能全部归因于新版。计量可能延迟。
- 本轮无法取得按Feed归属的最终人民币账单；调用计数与Cloudflare用量不能转换为已确认的整月费用，100元/月预算继续监控。未发起新抓取/OCR/测试邮件、未修改账本或套餐。

脱敏运行回执保存在Git忽略的`.private/t18-receipts/`：`monitor-20261013-2143-endpoints.json`、`monitor-20261013-2144-ledger.json`、`monitor-20261013-2145-cloud-usage.json`，以及同期admin回执。T18仍保持开放；隔离T17继续关闭。
