# 数据库与一致性设计

状态：2026-10-12 技术设计稿。落实[已确认业务规则](../production-design.md)，不是可直接执行的迁移。执行模型见 [Queue / Workflow](orchestration.md)，权益字段见 [Auth 契约](auth-contract.md)。

## 存储边界

首版采用一个业务 D1 数据库与一个私有 R2 存储桶。D1 保存身份、关系、状态、索引、任务和投递账本；R2 保存 HTML、截图、附件、正文 PDF、OCR 结果及固定后的邮件内容。Auth 的用户、邮箱和权益仍由 Auth 保存，Feed 只关联其稳定 `sub`。

现有 `feed_login` / `feed_session` BFF 表及其安全边界保留，不混入后台任务身份。数据库物理分片暂不引入，待实际读写量和数据库容量确定后再评估。

统一约定：ID 为应用生成的不可猜测 TEXT；时刻为 UTC 毫秒 INTEGER；日级源日期为 `YYYY-MM-DD` TEXT，另记时区与精度；布尔用受 CHECK 约束的 0/1；状态列使用 CHECK 枚举；FK 默认 RESTRICT。所有标记为“唯一”的组合都建立 UNIQUE 索引。下面列核心字段，省略通用 `created_at / updated_at`。

## 1. 来源与通知身份

| 表 | 核心字段 | 约束与主要索引 |
| --- | --- | --- |
| `sites` | `id, name, origin, enabled` | `origin` 不用于自动合并不同业务站点 |
| `sources` | `id, site_id, name, list_url, adapter_key, config_json, config_version, enabled, refresh_interval_sec, next_discovery_at, baseline_cutoff_at, backfill_cursor` | 索引 `(enabled,next_discovery_at,id)`；栏目变更配置递增版本；任务 payload 保存完整配置快照，不能只保存版本号再读取已被覆盖的当前 JSON |
| `articles` | `id, canonical_url, latest_observed_revision_id?, latest_ready_revision_id?, next_revision_no, capture_fence, capture_lease_until?, next_recheck_at, first_seen_at` | URL 唯一；索引 `(next_recheck_at,id)`；两个版本指针必须属于本通知 |
| `article_sources` | `article_id, source_id, first_seen_at, last_seen_at, discovery_class, published_at?, published_day?, date_precision, source_timezone` | PK `(article_id,source_id)`；索引 `(source_id,article_id)`；首次发现与历史分类不能被普通重试改成“现在” |

URL 规范化仅删除已知追踪参数、统一可证明等价的形式，保留决定文章身份的 query。相同 canonical URL 共享版本，跨栏目另记关联；不同 URL 的转载不自动合并。`discovery_class` 为 `live / backfill / migrated`。首次抓取历史页建立基线，不能生成“刚更新”的邮件资格。

发布日期保存于来源关联及版本的来源元数据中；来源冲突保留证据，不用最后一次抓取随意覆盖为当前日期。抓取、订阅生效、源发布时间、变更观察、归档就绪、邮件提交分别有自己的时间。

## 2. 原件版本与派生结果

| 表 | 核心字段 | 约束与主要索引 |
| --- | --- | --- |
| `article_revisions` | `id, article_id, revision_no, previous_revision_id?, capture_task_id, observed_at, state, requirement_generation, manifest_object_hash?, raw_fingerprint?, semantic_fingerprint?, change_kind, ready_at?` | 唯一 `(article_id,revision_no)`；唯一 `capture_task_id`；索引 `(article_id,revision_no DESC)`；`state=ready` 必须有清单、fingerprint、ready_at |
| `revision_requirements` | `revision_id, slot_key, kind, original_url?, filename?, required, state, object_hash?, derived_output_id?, fetched_at?, error_code?` | PK `(revision_id,slot_key)`；索引 `(revision_id,required,state)`；`kind=body/snapshot/attachment/body_pdf/body_ocr` |
| `artifact_objects` | `sha256, r2_key, byte_size, media_type, verified_at` | PK `sha256`，`r2_key` 唯一；物理对象按字节去重，不按文件名去重 |
| `derived_outputs` | `id, input_hash, processor, processor_version, options_hash, result_hash, completed_at` | 唯一 `(input_hash,processor,processor_version,options_hash)`；输入和结果均引用对象；只记录成功结果，失败在任务表 |
| `article_read_models` | `article_id, revision_id, title, summary, readable_text, extraction_generation` | 每篇一条当前阅读投影；FTS 索引从这里更新；可重建，不是历史原件 |

`article_revisions.state = assembling / ready / blocked`。`blocked` 是缺项或处理失败，可修复，不能作为完整版本输出。`change_kind = baseline / substantive / presentation_only / unclassified`；未能判定的变化先保持待核实。正文、必要附件、原貌及正文 OCR 分别列出要求；不需要 OCR 就不创建必需 OCR 项。

版本清单在开始组装时冻结预期文件集合。缺项允许由 NULL 填入第一次成功验证的对象，但已有对象关联不可替换；变更文件集合或替换已抓文件应建立新候选版本。版本 ready 后，元数据、原件引用和当时采用的 OCR 引用均冻结。后续改进 OCR 新增派生结果，更新阅读投影，原版本清单保持原样。

原件写入：先计算并校验 hash / 文件签名，写入不可变 R2 key，再在 D1 关联。R2 与 D1 没有跨服务事务；崩溃留下的未引用暂存对象可由延迟清理回收，任何已被历史版本引用的对象都不得自动删除。不能把 R2 中存在一个对象当成整个版本完整。

有两个不同的 fingerprint：

- `raw_fingerprint`：已归档正文及文件清单/字节身份，决定是否存在新的源版本。仅重新截图或随机页面噪声由适配器明确排除，不能随意丢弃正文差异。
- `semantic_fingerprint`：规范化正文、重要字段、附件集合/内容，辅助判断是否需要提醒。规则带版本；不能用新算法重算旧记录后制造“源站更新”。附件无法可靠比较时进入差异复核或保守判为实质变化，不能仅因文件名没变就忽略。

**不建立 `UNIQUE(article_id,raw_fingerprint)`。** 源站 A → B → A 是三次被观察到的版本，可复用 A 的物理文件，仍保留第三次出现的版本及更新事件。只有与紧邻的上次观测相同才视为无变化。

补抓必须重新建立源站会话，并核对正文、附件清单及已取得文件的版本证据；发现已变则创建新候选，不能把新版附件填入旧清单。源站没有快照或稳定校验标识时，无法承诺所有文件来自精确同一瞬间，需记录各文件抓取时间；无法确认旧缺项对应字节时保留缺项，不伪造完整历史。

同一文章的采集采用数据库租约与递增 `capture_fence` 防止交错写入。它只保护文章一致性，不控制全局或站点吞吐。所有发布写操作验证 fence；过期执行者不得分配版本、修改清单或移动指针。OCR 可以补齐旧版本，但 `latest_ready_revision_id` 只能向更大的版本号前进。通知事件按各版本产生，必要时注明“较早发现、现已补全”，不会把旧版伪装成最新原文。

## 3. 订阅和一对一 RSS

| 表 | 核心字段 | 约束与主要索引 |
| --- | --- | --- |
| `feed_accounts` | `auth_sub, mail_enabled, preference_revision` | PK `auth_sub`；不复制用户密码、主邮箱或长期权益事实 |
| `subscriptions` | `id, owner_sub, name, requested_enabled, priority, email_mode, activated_at, deleted_at?, rss_token_hash, rss_token_ciphertext, rss_token_generation, rss_revoked_at?` | `rss_token_hash` 唯一且非空；索引 `(owner_sub,deleted_at,priority,created_at,id)`；`email_mode=off/immediate/daily_digest` |
| `subscription_sources` | `id, subscription_id, source_id, effective_from, removed_at?` | 部分唯一索引 `(subscription_id,source_id) WHERE removed_at IS NULL`；索引 `(source_id,removed_at,subscription_id)` |

RSS 凭证直接属于订阅：天然每订阅一个，不再增加 RSS 数量配额或聚合关系。生成至少 256 bit 随机 token，保存 hash 用于 RSS 校验，并用 Worker secret 加密保存 token。登录后的订阅所有者可在设置中持续查看和复制当前链接；只有显式重置才改变凭证。密文绑定订阅 ID、所有者及凭证代次，使用独立用途标识，不能挪用会话密文。创建重试或刷新可返回同一有效链接，撤销后的链接不作为有效链接展示。日志、追踪和 Referer 不记录 token。

栏目目标用加入区间而非覆盖式列表：删除后再加入同一栏目产生新行和新 `effective_from`。选择站点时一次性展开当前栏目并保存这些行；后续新栏目不匹配。RSS 可查看当前目标内的完整历史，不受邮件生效时间限制；邮件按对应目标的加入时间判断。

创建数量按所有未删除配置计数；用户主动暂停的配置仍占配置数量，不能靠暂停绕开创建配额。降额保留超额配置，不再允许继续创建；实际运行集合为 `requested_enabled=1` 中按 `(priority,created_at,id)` 排序的前 `sub_limit` 个。priority 默认相同，即先创建先保留；用户调整顺序会更新 `preference_revision`。RPC 仅以 `{kind:"unlimited"}` 表达明确无限，缺失是 `{kind:"missing"}`，不得沿用旧 `null` 歧义。

权益暂停是计算结果，与用户主动关闭、删除、RSS 撤销分开。不得将降额批量写成 `requested_enabled=0`，否则恢复时会丢失用户意愿。RSS 凭证不因降额被重置。

创建订阅从 Auth 取得新鲜权益后，以**单条条件 INSERT**限制数量；随后写目标必须限定到这次成功创建的订阅。请求用稳定的创建 id 去重，采用 D1 `batch()` 包含全部写入。示意 SQL（`limit_value` 为已校验数字；无限使用单独分支）：

这一流程全部属于 Subscriptions Module 的 Implementation；HTTP Adapter 只调用 `change(actor,createCommand)`，不自行拼接查权、SQL 和复核。下列 SQL 描述内部一致性约束，不是要求每个调用者照抄的步骤。

```sql
INSERT INTO subscriptions (id, owner_sub, name, requested_enabled, priority,
  email_mode, activated_at, rss_token_hash, rss_token_ciphertext, rss_token_generation, created_at)
SELECT :id, :owner, :name, 1, 0, 'daily_digest', :now, :rss_hash, :rss_ciphertext, 1, :now
WHERE (SELECT COUNT(*) FROM subscriptions
       WHERE owner_sub = :owner AND deleted_at IS NULL) < :limit_value;

INSERT INTO subscription_sources (id, subscription_id, source_id, effective_from)
SELECT :target_id, :id, :source_id, :now
WHERE EXISTS (SELECT 1 FROM subscriptions WHERE id = :id AND owner_sub = :owner);
```

`changes=0` 不会自动让 batch 回滚，因此每条后续写入都要有成功条件，不能无条件插入凭证/栏目。实际实现还须校验源可订阅、创建请求内容一致，冲突重放读取原结果。不要采用“先在 JS count，再 await insert”。Auth 与 Feed 无跨库事务：期间降额可能使新配置刚创建就被暂停；输出前重新核权保证不会长期多运行。

## 4. 内容事件与邮件账本

| 表 | 核心字段 | 约束与主要索引 |
| --- | --- | --- |
| `content_events` | `id, revision_id, article_id, kind, observed_at, ready_at, history_only, payload_hash` | 每个需要对外呈现的版本最多一个事件，`revision_id` 唯一；索引 `(ready_at,id)`；`kind=initial/update` |
| `event_sources` | `event_id, source_id, article_source_first_seen_at, discovery_class, published_at?, published_day?, date_precision, source_timezone` | PK `(event_id,source_id)`；来源证据冻结；索引 `(source_id,event_id)` |
| `event_source_corrections` | `id, event_id, source_id, generation, request_id, command_hash, evidence_object_hash, corrected_dates_json, verified_by, verified_at` | 唯一 `(event_id,source_id,generation)` 和 `(event_id,source_id,request_id)`；同请求同内容重放，改内容冲突；只追加核实证据，当前判定选择最大 generation |
| `notification_matches` | `event_id, subscription_id, target_id, owner_sub, eligibility_kind, matched_at` | 唯一 `(event_id,subscription_id,target_id)`；索引 `(owner_sub,event_id)`；保留命中解释，不复制内容 |
| `user_deliveries` | `id, owner_sub, event_id, state, delivery_kind, available_at, claimed_message_id?, suppression_reason?, backlog_at?` | 唯一 `(owner_sub,event_id)`；索引 `(state,available_at,owner_sub)`；`backlog_at` 保留暂停积压事实，恢复/重匹配不改回即时提醒 |
| `mail_messages` | `id, owner_sub, kind, state, payload_key, payload_hash, recipient_hash, idempotency_key, provider_id?, submitted_at?, accepted_at?, delivered_at?, bounced_at?, complained_at?, lease_token?, lease_until?, next_attempt_at?, attempts, last_error?` | `idempotency_key` 唯一；`provider_id` 非空时唯一；首次提交前固定快照。T12 再加入摘要窗口及分批身份 |
| `mail_items` | `message_id, delivery_id, event_id, ordinal` | PK `(message_id,delivery_id)`；已提交/结果不明的 delivery 不得被另一 message 占用；历史取消消息可保留同一 delivery 的旧关联 |
| `mail_webhook_receipts` | `id, message_id?, payload_key, payload_hash, state, received_at, processed_at?, attempts, next_attempt_at, last_error?` | 供应商回调 ID 主键；主动查询证据使用独立 `lookup:` 前缀；验签后持久化再返回成功；处理有界重试 |

事件只来自 ready 版本。历史基线也可以创建 `initial/history_only=1` 事件供 RSS 查询，但没有历史邮件资格；排版版本及 OCR 重做不创建 `update`。RSS GUID 使用永久稳定的 `urn:cqu-feed:event:<id>`，URL 指向对应 revision。正文和所有原件仍须登录检查 `feed.access`。

新版本事件创建时保存当时已知来源。已归档文章后来出现在另一个栏目，应补充 `event_sources` 并触发该来源的匹配；不新建事件、不改变旧来源证据。该关联不能把栏目出现前的修改变成新更新：更新匹配还要求该栏目关联在变更观察时已存在。重复来源消息按复合主键去重。

邮件资格由事件与**命中目标的 `effective_from`**决定：

| 情形 | 资格 |
| --- | --- |
| 准确发布时间的首次通知 | live 事件，`published_at >= effective_from` |
| 只有日级发布日期 | live 事件，发布日期不早于目标加入当地日期，且该来源 `first_seen_at >= effective_from` |
| 日期未知 | 存档和待核实；不自动推送，包括 RSS，直到日期核实 |
| 历史补抓或迁移基线 | 网页/RSS 可见，不发新增邮件 |
| 已有旧文的实质修改 | 非基线更新，`observed_at >= effective_from`，且该栏目关联在观察前存在；不要求旧文最初发布日期晚于订阅 |
| 订阅前观察、订阅后才补齐的变化 | 不补发，`ready_at` 只控制何时允许输出，不改变事件发生资格 |

日期核实是对来源证据的有审计修正，不能直接改旧冻结记录：保存核实任务、`event_source_corrections` 及证据对象，读取时采用最新核实结果，并触发同一事件重新匹配；不另造一个事件。首次日期确认为历史时仍不发新增邮件。

匹配使用来源索引和主键游标分批进行，每批插入 match、`INSERT … ON CONFLICT DO NOTHING` 创建 delivery、更新游标在同一 batch。用户有多个命中时合并为一个 delivery；当前有效命中中有 immediate 就优先及时，否则 daily_digest，全部 off 则不进入发送候选。RSS 直接从事件和当前栏目关系查询历史，不为每次阅读器拉取制造 match 行。

分页保存各目标解释，同时按本页用户的全部当前来源/目标计算共享候选，避免分页顺序误判积压。日期撤回或资格消失会暂停既有 pending 候选；其他已核实且合格的来源仍可保留其资格。已有邮件占用或受理事实不被重匹配覆盖。

所有发送入口共享 `user_deliveries` 占用。先条件更新 `pending → claimed`，写固定 message/items，再提交外部请求；失败的竞争者不能把相同 delivery 加到自己的邮件。关联插入需验证 `claimed_message_id` 正是自己，不能忽略 CAS 失败。

每日 20:00 北京时间固定 UTC 窗口末端，选取截至窗口就绪、已匹配且仍 pending 的事件；按用户合并并持久化快照。**不只读取“上次游标以后的就绪时间”**：匹配延迟或 Auth 故障时的旧 pending 也要补入下一可发送批次。空集合不建邮件；同一窗口重复调度返回已有 message。正文过大时进入显式分批策略，首版阈值待供应商确定，不能静默丢条。

发送前重查有效订阅、当前权益、mail_enabled、退信/投诉状态和 Auth 已验证邮箱。取消未提交消息后可以释放 delivery 重新组合；邮件一旦可能提交过，就固定收件人、内容和幂等键，不能用同一键换邮箱或加新条目。`accepted` 或 `submission_unknown` 都阻止摘要再次占用相同 delivery。Webhook 只前进事实（submitted/accepted/delivered/bounced），乱序事件不把已受理邮件退回未发送。

邮箱抑制按邮箱摘要保存到单独的 `mail_suppressions(email_hash,reason,created_at,cleared_at?)`；换邮箱不自动解除旧邮箱抑制。偏好/权益暂停期间保留候选，恢复后重新评估；积压的既有 pending 合并进摘要，避免立即补发大量及时邮件。此为技术默认，可在产品层调整。

## 5. 执行任务与事务消息

| 表 | 核心字段 | 约束与主要索引 |
| --- | --- | --- |
| `tasks` | `id, kind, business_key, source_id?, article_id?, revision_id?, payload_object_hash?, state, priority, due_at, attempt_no, lease_until?, checkpoint_json?, last_error?` | `business_key` 唯一；索引 `(state,due_at,priority,id)`；状态机见执行设计 |
| `task_attempts` | `task_id, attempt_no, workflow_instance_id, state, started_at?, ended_at?, error_code?` | PK `(task_id,attempt_no)`；instance id 唯一；Workflow 留存过期后仍有业务记录 |
| `outbox` | `id, topic, dedupe_key, payload_json, available_at, state, lease_until?, attempts, last_error?` | `(topic,dedupe_key)` 唯一；索引 `(state,available_at,id)`；内容仅含消息版本和业务 ID |

`tasks.checkpoint_json` 保存可重建的小型分页游标；不可变原始结果在 R2。调度来源、订阅扇出和摘要准备均有持久进度，不能只靠 Worker 内存。

关键提交边界：

1. **任务产生**：更新 source 下次时间/分页游标 + 插入唯一 task + 对应启动 outbox。
2. **原件入库**：先有 R2 已验证对象，再插对象关系 + 满足对应 requirement；事务失败可复用对象重试。
3. **版本就绪**：条件更新 assembling → ready + 插入唯一 content_event/event_sources + 更新向前的阅读指针 + event outbox。必须以仍有效的版本状态、全部必需项成功、清单冻结及分类已完成作为同一个 SQL 条件；后续语句从符合条件的 ready 版本 SELECT，禁止先 JS 判断再无条件 UPDATE。
4. **订阅扇出**：一个有界分页内 match + delivery + 后续任务/outbox/游标。
5. **邮件准备**：抢占 delivery + message/items + mail outbox；对象内容先写 R2，提交边界内只保存不可变引用。

D1 使用 `DB.batch()` 的原子提交能力；其中一个语句失败会回滚该批。批内 `UPDATE … WHERE …` 没匹配到记录并不等于语句失败，必须显式门控后续写入。不要把跨多个 await 的业务操作描述为一个事务。涉及租约、配额、占用和状态推进的读写走 primary；首版不依赖副本最终一致的读结果做授权或额度裁决。[D1 batch 官方说明](https://developers.cloudflare.com/d1/worker-api/d1-database/)

外部 Queue / R2 / Firecrawl / 邮件 API 不参与 D1 事务。outbox 在发送成功后标记已分发，发送后标记前崩溃会重复发送，因此消费端必须按业务键幂等。禁止先标记已发送再调 Queue。

## 迁移与验收

采用新增 v2 表/字段、后台导入、校验、切读的渐进迁移，保留 MVP 原表和 R2 对象直至回滚窗口结束。每篇 MVP 文章创建 migrated 基线及来源关联，已保存附件和 OCR 引用映射为历史版本；缺附件/必要 OCR 的文章导入 assembling，不能因为旧 status=complete 就标记 ready。迁移不创建任何邮件 delivery。

首版搜索索引只跟随最新完整阅读投影；历史版本按通知时间线浏览。全版本全文搜索可后续增加，不把每个 OCR 重算都塞入主搜索结果。

实现验收至少覆盖：并发建订阅不超额；降额保留配置；A→B→A 三版；同名附件替换不覆盖；旧 OCR 晚到不回退当前版本；失败补抓不混合版本；同事件多订阅只占一条 delivery；ready 与 outbox 原子；匹配延迟跨摘要窗口不丢；邮件结果不明不盲目重复提交。此文定义设计约束，尚未证明生产数据库行为。

### T11 已实现边界

邮件正文、收件地址和验签后的回调保存在私有 R2 `private/mail/sha256/` 下，D1 只保存 hash、对象引用及安全状态。普通文件 API 只允许文章/版本中已记录的引用，不提供任意 R2 key 下载。邮件快照不加入文章 artifact 表。

首次提交的 CAS 同时复核订阅配置版本、事件来源数量、日期修正代数及冻结邮箱的抑制状态；获取提交租约后再次读取抑制状态，已退信/投诉的邮箱不提交外部请求。租约以预检结束时的新时间建立，并对已评估的 attempt 和原提交时间加锁；CAS 失败不提交外部请求。提交前落盘 `submitting`、最早提交时间和两分钟租约；网络或本地受理记账失败都保留原占用。Resend 最多在最早提交后 23.5 小时内用原请求重试，留出窗口余量；超时、达到尝试上限或当前资格/邮箱改变时保留结果不明并等待对账，不更换 key。明确未受理的限流可持久延期，尝试上限后等待管理员处理。

### T12 摘要窗口

`0016_mail_digests.sql` 新增 `mail_digest_windows`，以 `(owner_sub,window_end)` 为主键，持久化扫描游标、下一批编号和 open/closed 状态。窗口末端固定为北京时间20:00；每轮恢复最多推进20个窗口，每个窗口最多一页。扫描同时限制事件 `ready_at` 与 delivery `created_at` 不晚于窗口，晚就绪或晚匹配的 pending 会被下一窗口重新选中，不依赖全局 ready 水位。

编排通过窗口游标/批号的条件更新占用批次，在同一 D1 batch 内占用全部成员；只有成功占用数量与快照条目数完全相等时才创建 message/items/outbox，否则释放本次部分占用，保留原游标。已形成的批次固定内容、收件人和幂等键；已关闭窗口不追加新成员。取消从未提交过的摘要会释放成员供后续批次重新评估，可能已提交的摘要继续保留占用。

准备与提交对整批只获取一次当前 Auth 邮箱/权益，再逐篇使用相同资格规则；提交 SQL 用 JSON 记录逐篇来源数量和日期修正代数，以免大量占用 SQL 绑定参数。所有成员都必须仍然合格。每批同时受条目和 UTF-8 JSON 字节上限约束，游标不越过因大小留下的下一篇，剩余内容由后续恢复继续准备。
