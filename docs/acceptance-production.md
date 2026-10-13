# 正式版隔离验收（T17）

日期：2026-10-13，Asia/Shanghai。此页记录真实隔离环境；历史 MVP 证据见 [acceptance.md](acceptance.md)。T17 真实20:00摘要已于20:01送达并由用户截图确认；用户已于同日授权直接正式上线，T18执行进度见 [正式发布记录](release-production.md)。

## 范围与资源

样本全部由隔离源 Worker 生成：1 个站点、2 个栏目、3 篇通知。五个真实学校来源与站点均暂停。没有将生产学生名单或既有 OCR 样本导出、导入隔离环境，也没有修改生产 D1/R2。

| 资源 | 隔离标识 |
| --- | --- |
| Feed | `cqu-feed-t17-20261013` |
| Auth | `cqu-moe-auth-t17-20261013` |
| 合成来源 | `cqu-feed-source-t17-20261013` |
| Feed D1 | `cqu-feed-mvp-t17-20261013` / `bdafe3e0-f639-4280-ac82-b85fb3fc407b` |
| Auth D1 | `65ce73c3-fdf3-43ee-8049-644d1f242b7f` |
| R2 | `cqu-feed-archive-t17-20261013` |
| Queue | `feed-{jobs,events,mail}-t17-20261013`，分别有 DLQ |
| Workflow | `cqu-feed-{ingest,pdf-ocr,capture,discovery,archive-ocr}-t17-20261013` |

收件人仅用户指定的 `uu@401.moe`；发件人为 `重大通知 <notifications@feed.cqu.moe>`，Resend 已验证该域。OCR 使用 TextIn。邮箱通过实际验证码验证，之后正常 OAuth 登录 Feed；降额和邮箱状态演练使用隔离 Auth 的正常管理员接口。

## 已通过的真实业务

| 验收 | 实际结果 |
| --- | --- |
| 多栏目采集 | 两栏目验证成功；相同 URL 共用通知，后来发现的栏目关联原通知；新 URL 独立存档。 |
| 历史补抓 | 第二栏目补抓365天（2025-10-13至2026-10-13），1列表页、2篇历史通知；不发历史邮件。 |
| 迁移 | 合成 MVP 基线迁移2文章、4附件、2完整版本，差异0；复用已有 TextIn 结果，无重新 OCR。 |
| 完整性发布 | 附件变更时实际观察到新版本 assembling/missing1，旧版本仍可读；新正文 PDF OCR 完成后才发布新版本。 |
| 版本保留 | 共用通知先后保存A、B、A2、附件变更、排版变更5版；各版独立详情200，10份附件下载 hash 全部符合对应原件。 |
| 无实质变更 | 迁移后的历史通知原文不变复查、共用通知仅排版变化均为 presentation_only；不产生新的更新事件。 |
| RSS | 两个即时订阅分别5条，第一栏目每日订阅1条；实质更新独立条目、固定版本链接。主人可持续查看链接；轮换后旧链接404、新链接200。 |
| 即时邮件 | 正文B、A2各1封；同一用户多个订阅命中仍共用1次投递。真实收件箱确认2封，均只到指定地址。 |
| 额度 | 第4个订阅创建403；Auth额度3降1保留全部3份配置、暂停超额RSS/邮件；用户排序改变保留集合；恢复3后全部运行。 |
| 未验证邮箱 | 临时 emailVerified=false：配置保留、RSS仍200、界面显示暂停邮件；MAIL_ENABLED=true时真实准备入口prepared0，待发附件更新保留为email_unverified摘要积压；恢复已验证状态后全部active。 |
| Auth不可用 | 实际移除隔离 Feed 的 AUTH_FEED_RPC 绑定；配置可见但auth_unavailable，3个RSS带缓存条件均503；恢复绑定后均200。此为真实绑定不可用演练，不称为Auth服务宕机。 |
| Workflow恢复 | 首次来源验证因Cloudflare要求retries.delay而失败；修复后正常恢复同一task的第2次attempt成功。失败发生在供应商调用前。 |
| 邮件结果不明 | 单次故障wrapper实际调用Resend，受理后保存R2收据并丢弃响应；立即submission_unknown，真实签名webhook推进同一邮件delivered，attempts1；正常对账仍delivered，没有重发。 |
| 读取回滚 | 临时关闭ARCHIVE_READS，旧版详情/OCR/附件仍200；重新开启后恢复版本读取。没有倒退D1或删除历史事实。 |
| 阅读 | 真实会话中文搜索、原貌快照、PDF阅读器canvas和文件hash检查通过；匿名PDF401。 |

新通知首次发现至完整就绪为 **38.840秒**（单个live样本）。此次手动推进outbox，完整就绪后约208.6秒完成订阅匹配；不是稳定吞吐或生产时延承诺。02:54诊断没有未处理任务、缺项、邮件结果不明或失败收据；每日摘要候选仍待20:00，不能把这称为全部邮件已清空。

## 用量和费用边界

用户批准隔离验收总费用上限人民币50元。未购买套餐、充值、修改付款方式或处理账户欠费。

| 服务 | 验收实测 | 证据边界 |
| --- | --- | --- |
| Firecrawl | 15调用；账户credits 1000→985 | 官方credit-usage只读接口与Feed usage一致；消耗已有额度。 |
| TextIn | 3次单页识别；有效套餐余量1992→1989 | 官方package查询与每日/月预留3页一致；finance余额/待支付均0，预付费。日/月是同一消耗的两个统计维度。 |
| Resend | Auth验证码1封、Feed更新2封、摘要1封 | Feed更新2封、20:00摘要1封均有delivered与真实收件证据。 |
| Cloudflare | 2业务Worker、1合成源、2 D1、1 R2、6 Queue、5 Feed Workflow | 临时邮件故障Worker已删除并回读404；已核对Analytics增量与账户累计用量，见下表；不是最终账单。 |

官方查询口径：[Firecrawl credit-usage](https://github.com/firecrawl/firecrawl-docs/blob/main/api-reference/v2-openapi.json)、[TextIn套餐余量](https://www.textin.com/document/open_api_package)、[TextIn余额](https://www.textin.com/document/open_api_balance)。已有套餐计数不等同于单价；没有伪造人民币账单。此前账户欠费弹窗金额不归因于本次验收。

Cloudflare只读Analytics快照于02:40–02:52取得；账户累计从2026-10-01T00:00Z起算，隔离用量从2026-10-12T00:00Z起算。数据有采集延迟，今晚摘要后再增量核对。

| 计量项 | T17隔离实测 | 本月账户累计（含其他应用） |
| --- | --- | --- |
| Worker请求 | Feed356、Auth226、合成源73，均无已上报错误；已删除故障Worker数据不可用，不能计作0 | 57,042请求，CPU1,227,839.076毫秒 |
| D1读/写行 | 97,097 / 2,947 | 4,293,916 / 105,262 |
| R2操作 | Class A203、Class B449 | Class A1,095、Class B10,924 |
| R2存储 | 最新17:50Z样本136对象、payload3,077,035字节；该读数滞后于后续版本 | 各桶峰值payload+metadata合计约5.342GB；这是保守峰值合计，不是GB-month账单 |
| Queue计费操作 | jobs48、events81、mail6，共135；DLQ未返回操作数据 | 1,005 |
| Workflow | 22次启动、75个step.do、CPU4,380毫秒；包含已留证的1次失败 | 2,348个step.do、CPU39,015毫秒；allStepCount3,363不是计费step.do数 |

已查请求、CPU、行数、Queue操作、R2操作/存储及Workflow步骤均低于现有公开包含额度。未新增套餐，以上维度当前没有显示越过包含额度；不据此保证整月增量费用为0，也不把Workflow storageRate当作已结算GB-month。[Workers定价](https://developers.cloudflare.com/workers/platform/pricing/)、[D1定价](https://developers.cloudflare.com/d1/platform/pricing/)、[R2定价](https://developers.cloudflare.com/r2/pricing/)、[Queues定价](https://developers.cloudflare.com/queues/platform/pricing/)、[Workflows定价](https://developers.cloudflare.com/workflows/reference/pricing/)。

计量请求和结果分别保留：`.private/t17-{resource-cost,account-cost,queues-cost}.graphql`、`t17-cloud-usage.mjs`及`t17-receipts/`对应JSON。Queue身份映射来自同次验收的`.private/t17-current-queues.txt`：jobs=`46e107ca7af743ba98e1f14918b2e2c3`、events=`c8e0c27c4203472baa828062a8ddccb2`、mail=`b76f12c75e3749a28a6bc3e30f426673`。统计中另一个`aa1da47e6eff4193a888b740cd2bf58b`的66次属于`schedule-sync`，不计入T17的135次；三个T17 DLQ也在原列表中，查询未返回它们的操作行。

隔离抓取上限16次/UTC日，正文OCR5页/UTC日、20页/月；任务尝试3次，启动交接2次，任务退避60–600秒，邮件最多3次。近期复查600秒、旧通知900秒仅为短时演练值，不能直接用于全量生产。暂停抓取后不会继续进行周期性付费采集。Firecrawl/TextIn临时Key可撤销；Resend需完成摘要验收后撤销。

## 云端发现并修复的问题

- `59411ce`：Cloudflare Workflow即使retries.limit=0仍要求delay；本地契约回归后实际失败任务恢复成功，CI38284714405成功。
- `2f90874`：订阅输出状态仍有T11占位；改为实际邮件开关及正确UI，CI38286784239成功。
- `9631c7b`：MVP迁移正文含PDF阅读文本，新抓取的指纹需按迁移基线比较；保持不可变旧指纹，真实不变复查已证明无误报。该提交CI38289297817有1项既有异步测试失败，不标为CI通过。
- `2874147`：晚到栏目测试错误地要求指定的dispatch调用必须抢到消息。真实Workflow可以先派发；调整为等待前序匹配、提前设置提交屏障，再观察用户可见匹配结果。重复派发复现红灯后修复绿灯，业务断言保留。
- `785739a`：OCR运维指标将日/月processed_pages相加，导致实际3页显示6页；修改为累计月统计，既有诊断测试以双维度数据复现红灯后通过。供应商没有重复扣费。
- `021fe31`：读取PDF原件中断时兼容指纹漏了MVP占位文本，会把未变通知判为实质更新；在已批准的Archive故障注入边界复现红灯，补齐失败路径后12项迁移回归通过，真实正文修改负控仍为substantive。未为此追加付费抓取或OCR。

源码 `785739aff056952faa6fb56e6adb468f6c13a7f8` 的197项测试与[远端CI38292016688](https://github.com/cqu-moe/feed/actions/runs/38292016688)成功，实际运维API和界面均显示OCR3页。随后PDF读取失败修复的源码为 `021fe3124894b2e7f11fc5358b56bfddc9d4efdb`：本地198项测试、构建、设计检查和Worker dry-run通过；[对应CI38293926243](https://github.com/cqu-moe/feed/actions/runs/38293926243)成功。当时隔离部署 `6436672c-0c52-4666-8cf9-db110e23fd35` 健康200，诊断确认没有新增付费抓取/OCR。原始失败CI与红灯日志保留，不用后续成功覆盖历史证据。

## 独立复核与最新部署

2026-10-13上午对逐任务审查后的云端修复做独立复核，范围、模型和完整闭环见[独立复核记录](reviews/t17-independent-review.md)。Standards发现1项P2（旧journal重放），Spec发现1项P1（混合PDF历史表示），GLM5.3证据核对发现1项P2（跨UTC日/月诊断旧计数）；三项均已在`d56a1e317ebc884318cba5187091060445be35a3`修复，并由原审查代理独立复审关闭，无新增发现。

本地完整203项测试、构建、设计检查和Worker dry-run通过；[远端CI38329786882](https://github.com/cqu-moe/feed/actions/runs/38329786882)对同一SHA成功，远端同样203/203。Main重新构建集成目录并用T17专用配置预检，然后部署隔离版本`68d10467-cee8-4318-bfa0-435101a160cf`；没有新增迁移或付费抓取/OCR。

09:06北京时间实际读回：健康200，诊断200，`ocrPagesToday=0`（UTC当日）、`ocrPagesThisMonth=3`、累计`paidOcrPages=3`、`paidVendorCalls=15`；任务/缺项/未知邮件均为0。邮件账本仍只有此前2封immediate，均delivered、attempts1。原始回执为`.private/t17-receipts/independent-review-final-{health,diagnostics,mail}.json`，CI回执为`review-ci-run-final.json`。没有把本地混合PDF回归称为新增真实供应商验收；今晚真实定时摘要仍待验。

## 真实20:00摘要（已通过）

用户在本会话提供收件箱截图：2026-10-13 20:01收到《每日摘要 · 2026-10-13》，收件人仍为指定地址。隔离D1记录显示：

- 摘要消息 `aba4181c48d3ceeb64709010`，20:00:47提交，20:01:02送达，`delivered`、`attempts=1`。
- 正好2项：更新事件 `b2e1d16fb2cd0e793aa15f44`（邮箱验证恢复后的积压）和新通知事件 `7e5ec32e0ca8993adadf1f9e`。与截图中的两条合成通知一致。
- 两条真实签名回执于20:01:07和20:01:13处理完成；摘要窗口为真实20:00、状态closed、分片数1。没有修改时钟或伪造回执。
- 此前两封即时邮件仍各attempts1；所有mail_items重复event数0，共4个user delivery均delivered。任务积压、缺项、未知邮件结果均0。
- Firecrawl调用仍15次、TextIn仍3页；今晚没有新增抓取/OCR。原始回执为`.private/t17-receipts/digest-evening-{mail,ledger,diagnostics}.json`，用户截图不复制到Git。

### 晚间增量计量

20:05读取：隔离Queue累计138次操作（events81/jobs48/mail9；此前135），R2累计PutObject205/GetObject209/HeadObject220/HeadBucket30/PutBucket1；最新存储快照197个对象、4,540,364字节（快照时间19:40，早于摘要）。Workflow成功数未增加，仍为旧PDF6、采集8、发现5、归档OCR2，保留此前1次发现失败记录。

Worker/D1首次晚间Analytics查询遇到Cloudflare五分钟限流；遵守冷却后20:12单次重试成功。累计Feed/Auth/合成源请求分别593/228/73，这三项返回errors均0；Feed D1读取22,853行、写入2,251行，Auth D1读取82,134行、写入762行。查询窗口从10月12日UTC起，计量可能延迟，不是最终美元账单；隔离50元预算不与正式100元/月混算。错误及成功回执均保留，未把缺失结果填0。

## 收尾与范围边界

本次必需的隔离业务验收均已通过。20:08已部署关停配置，20:09读回MAIL/CRAWL/TASK_RUNTIME/PDF_OCR均为false、Cron为空；版本`9cfdcb6e-f738-4d76-b4e7-508a4ab839a9`，部署`ac503d93-1974-4313-9394-0400bfd5b73f`。三封已送达邮件仍保留原状态，未新增投递。关停配置dry-run通过；文档收尾前完整203项测试、构建、设计检查和Worker打包通过。T17 Issue #18据此完成。所有D1/R2原件、版本及投递事实保留，不删除账本。临时Resend Key已可撤销；此前Firecrawl/TextIn临时Key若尚未撤销可一并撤销，新的正式Sending Key继续保留。

正式发布及待观察项独立记录在 [T18发布记录](release-production.md) 和 [Issue #19](https://github.com/cqu-moe/feed/issues/19)：首个正式发现窗口、持续费用监控和生产回滚演练继续跟进。两栏目、三通知、一个账号的隔离演练不证明大规模吞吐；生产月预算和初始额度已单独确定，不再视为T17未决项。
