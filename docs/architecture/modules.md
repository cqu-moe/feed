# Module 与 Interface 设计复查

状态：2026-10-12，使用 `codebase-design` 对正式版提案做结构细化；不改变已确认业务规则，不表示已重构 MVP。

## 核心调整

Queue、Workflow、D1 与 R2 是执行和存储手段。业务 Module 应完整承担一段行为，让 HTTP、定时器、Queue Adapter 与测试调用同一个 Interface；调用方不必另学租约、配额 CAS、版本就绪与 outbox 的操作顺序。

Interface 不止包含函数参数，还包括幂等身份、错误含义、是否已持久化、能否重试及执行成本。一个 Module 可以有内部 Seam，但不能因为测试想替换依赖就把所有存储细节暴露给调用方。

## 建议的业务 Module

| Module | Interface 中的行为 | Implementation 内部承担 |
| --- | --- | --- |
| `Sources` | `scheduleDue(now)`、`discover(taskId)` | 到期扫描、固定配置、历史分类、有限分页、发现记录及后续任务原子写入 |
| `Archive` | `capture(taskId)`、`extract(taskId)`、`reconcileRevision(revisionId)`、`readRevision(ref)` | 源站会话、fence、不可变原件、版本比较、OCR requirement、完整性与唯一事件/outbox |
| `Subscriptions` | `change(actor,command)`、`list(actor)`、`readRss(token,condition)` | 权益与创建数量、冻结栏目集、目标生效区间、运行集合、RSS 凭证及权限检查 |
| `Notifications` | `match(taskId)`、`prepare(ownerSub,cutoff)`、`deliver(messageId)` | 日期资格、分批命中、共享投递占用、摘要、当前权益/收件人、外部提交与结果不明恢复 |

这里的各个方法共同构成相应 Module 的一个 Interface，不是独立的细碎 Module。`capture/extract/discover` 是可能持续较久的任务执行；`change/readRss` 是交互请求；`match/prepare` 有界分批，返回可持久继续的结果，不能把全站/全用户遍历藏进一个看似快速的读取。

HTTP Adapter 验证会话并构造可信 actor，不能直接采用请求体里的 owner_sub。Module 负责业务授权，调用方不能通过“提前查过权限”参数跳过校验。管理员重试与定时触发使用同一任务身份和 Interface，不能绕过规则直接改表。

## 三个最需要收紧的 Interface

### Archive：调用者不领取租约，也不决定完整性

当前 MVP 的 `worker/workflow.mjs` 在调用 `collectArticle` 前直接操作文章租约，并在 catch 中维护状态；`worker/collect.mjs` 和 `worker/pdf-ocr.mjs` 又分别发布采集/识别结果。这些是现有实现位置，不能当作正式版已经有统一发布规则。

正式版 `Archive.capture(taskId)` 内部完成任务去重、租约/fence、原件保存、版本关系和后续 outbox。调用者只提供已持久化 taskId，不能提供 `markReady=true` 或自行写 ready。`extract` 的完成与采集完成都通过内部进展记录触发 `reconcileRevision`；该方法本身也必须可重复调用。

结果应区分 `unchanged / staged / blocked / deferred`；`staged` 只说明产物已保存，不代表可以推送。读取完整结果通过 `readRevision` 验证；没有完整版本时返回明确 unavailable，不拼接新旧文件。

删除这个 Module 后，会话、版本规则和完整性知识会重新散落到采集 Workflow、OCR Workflow、管理员恢复入口与阅读入口，因此它有实际 Depth。文件下载、正文差异比较可以保留内部小函数，不必全部独立为公开 Module。

### Notifications：发送前的顺序由一个 Implementation 掌握

调用方只传 messageId，不能按“查 Auth → 查去重 → 查邮箱 → 调邮件 → 标已发”自行串联。`deliver` 内部核查记录、订阅运行集合、当前 Auth recipient、抑制规则与固定 payload，再提交并保存结果。定时恢复和 Queue 重投都调用同一方法。

返回值至少区分 `accepted / deferred / suppressed / submission_unknown`，带稳定 messageId 与可公开诊断原因；不要统一成 `success:boolean`。`deferred` 必须已经保存 due_at 或 hold 原因；只有完成持久交接的结果才允许 Queue Adapter 确认。未落盘的异常必须传播为可重试失败。

`prepare` 内部完成 delivery CAS、固定邮件清单和 send-mail outbox；调用方不能传入一组“相信尚未发送”的 delivery ID。`match` 内部拥有分页 checkpoint 的提交，不能让 Queue Adapter 先保存下一页游标。

及时提醒、20:00 摘要、手动恢复和重复消息共用这套 Implementation，去重规则修改集中在这里，形成 Locality。

### Subscriptions：数量、运行集合与通道状态一起解释

`change(actor,command)` 接受明确的创建、编辑目标、排序、启停、删除和 RSS 轮换命令。它在内部判断这是增加配置还是调整已有配置；调用方不用记住“配置数量”和“运行数量”不同，更不能把超额状态等同于禁止重新排序。

结果包含配置身份、是否已保存及 effective status。写后 Auth 失败返回“已创建但暂停”的事实，不能让调用者误以为完全没创建。命令有 requestId，重复执行返回原结果或明确内容冲突。

`readRss` 内部先校验 token、Auth 和运行集合，再决定内容或 304；邮件未验证不影响 RSS。FeedPolicy 的解析和通道判断不能在路由、邮件发送器与 RSS 中各复制一套。

运行集合等纯规则可以作为小型共享计算 Module，直接接收配置与严格 policy、返回结果；它不做 RPC、不创建任务，也不包装成通用“权限框架”。跨 Module 的读取不会转移写入责任：订阅配置只有 Subscriptions 修改，投递记录只有 Notifications 修改。

## 执行支持与 Seam 放置

`TaskRuntime` 管理 task/attempt、Workflow 实例 ID、outbox 分发、接手确认及恢复。它不判断文章是否完整、谁应收到通知，也不负责决定配额。来源/归档/投递事务写 outbox 时，使用同一批内的私有 SQL helper；不能先让业务 Module commit，再调用一个“发事件 Module”补写 outbox。

执行文档中的 business key / instance ID 规则属于 TaskRuntime 的 Implementation 约定。调用者提供业务意图和稳定 requestId，不手工拼 key。任务提交的内部构造函数生成 task 与 outbox 语句，由拥有业务写入的 Module 一次 batch 提交；独立恢复入口只接受持久 taskId/attempt。这样既隐藏 ID 规则，也不拆散原子提交。

Cloudflare Queue/Workflow Adapter 只解析已约定消息、装配运行依赖、跨相应 Interface 执行并映射确认结果。Cloudflare `step` 对象留在执行 Adapter；业务调用方不需要导入 WorkflowEntrypoint 或自行命名持久步骤。现有三个 Workflow 与三条业务 Queue 保持不变。

| 依赖类别 | Seam 与实际 Adapter | 测试方式 |
| --- | --- | --- |
| 纯计算 | 日期资格、diff 分类、运行集合；直接函数，不制造 I/O port | 固定输入检查输出，覆盖业务分支 |
| 本地可替代 | D1/R2 留在 Module 内部存储 Seam | 使用 Miniflare 的实际 D1/R2 语义，通过 Module Interface 检查结果；不以宽泛 FakeRepository 代替事务验证 |
| 自有远端 | Auth 内部 port，生产 Service Binding Adapter；测试内存 Adapter | 返回授权、缺配额、不可用、未验证邮箱，检查调用方可观察行为 |
| 外部依赖 | Firecrawl、OCR、邮件各一个窄内部 port；生产 Adapter 与可控测试 Adapter | 覆盖 429、额度耗尽、伪附件、OCR 失败、受理后断线；不假装 mock 证明真实服务可用 |
| 平台执行 | 持久步骤/实例启动 Seam，Cloudflare Adapter 与可控重放 Adapter | 重复交接、步骤恢复、过期 attempt、写入后中断；另做平台集成验证 |

依赖在 Module 组装时注入，不由业务方法临时创建 SDK 客户端。测试 Adapter 是第二个确有用途的 Adapter；不为尚未计划采用的抓取供应商、邮件供应商或数据库另建一层泛化抽象。

[Auth 契约](auth-contract.md) 中带 `clientId/clientSecret/contractVersion` 的结构是跨部署传输格式。Feed 的业务 Interface 只提供 `authClient.getPolicy(authSub)` 与 `authClient.getRecipient(authSub)`；凭证、版本、Service Binding 与 transport exception 转换由 Adapter 在组装时接收并隐藏。业务调用者和测试都不构造 RPC credential envelope。

OCR 可在 Archive Implementation 内部形成 `process(inputDescriptor)` / `status(inputDescriptor)` 的 Module，复用既有 Mistral 与测试 Adapter；输入 hash、处理器版本与选项决定派生结果身份。它只报告识别结果，版本 requirement 和内容事件仍由 Archive 修改，不把“是否可以推送”的知识再分给 OCR 调用者。

## 通过 Interface 验证

| 场景 | 从 Interface 可观察的结果 |
| --- | --- |
| 重复执行同一 capture task | 返回同一观测结果，版本时间线不多一条 |
| 附件或必要 OCR 未齐 | readRevision 不返回部分新版本；没有新推送事件 |
| 原文 A→B→A | 可读到三个版本，第三版可复用原件但有独立事件 |
| 同事件命中多个订阅 | 只生成一个用户 delivery；及时与摘要无法各占一次 |
| 邮件服务已受理但响应丢失 | 返回 submission_unknown，后续重放保持原 payload/key，不创建第二封 |
| 配额下降后重排 | 配置完整保留，允许用户选择额度内运行集合 |
| Auth 暂时故障 | 返回可恢复暂停；配置不删除，额度不变成无限 |
| 邮箱未验证 | 邮件暂停，有效 RSS 仍可读 |

主要测试跨以上 Interface，而不是逐个 mock 私有 SQL helper。等新 Interface 测试覆盖旧行为后，再替换只断言内部调用顺序的重复测试；安全、SQL 约束和实际 Cloudflare 交接等独有证据继续保留。设计文件调整不要求立即重构或删除现有 MVP 测试。
