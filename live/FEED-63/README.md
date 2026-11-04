# 执行器切换的云端验收

使用一个临时 Worker、一个独立 D1、一个私有 R2、一个独立 Queue、独立的 Workflow 和最多三个容器。Worker 无 HTTP 路由、无定时器，没有邮件、Auth、付费 OCR 或生产绑定。普通 Workers Preview 不能注册 Queue 消费者，也不会创建独立 Workflow，因此这里部署单独命名的 Worker。

**测试的是真实 Queue、Workflow 和装有 Chrome 的 Container。** 三个学校域名是合成的，每台测试容器把它们解析至自身回环 HTTPS 服务。每次栏目请求保持 25 秒，在返回的 HTML 标题里写入起止时间。正常列表提取、R2 检查点、D1 业务结果不作替换。三个请求是否重叠以源站时间交集为准，单凭 Workflow 同时运行或 D1 已记录交接不能得出结论。

1. 使用当前仓库的 Wrangler。选一个全新前缀，如 `cqu-feed63-rehearsal-<日期后缀>`，分别创建 `<前缀>-db`、`<前缀>-archive`、`<前缀>-jobs`。从实际创建回执取 UUID。运行 `node live/FEED-63/configure.mjs <前缀> <UUID> queue`；此后每条 Wrangler 命令都传生成的 `--config work/<前缀>/wrangler.json`。
2. 用该配置 dry-run，核对所有绑定都在本次创建清单内，再对独立 D1 应用迁移，运行下列 SQL。仅向该库加入容易辨认的历史失败、阻塞任务、已有版本、事件和暂停游标，并在私有桶放入一份已知哈希的原件。取初始快照。
   ```sql
   CREATE TABLE probe_deliveries(task_id TEXT NOT NULL, arrived INTEGER NOT NULL);
   UPDATE sources SET enabled=0;
   ```
3. 部署旧执行方式，用 `wrangler workflows trigger <前缀>-driver '{"cmd":"old"}'` 投递一个任务。观察到其真实运行中的 `queue-…` 尝试后，执行 `wrangler queues pause-delivery <前缀>-jobs`。在停领期间触发 `backlog`，再触发 `dispatch`。记录六项任务的原 ID、尝试次数、发送与交接回执。
4. 等旧任务退出，将 D1 结果与私有桶中的原件相对照。不能仅看队列大小或消息回执；仍有未核清的旧执行时保持暂停。需要回退时也先停领、核清新执行；不得为回退覆盖已经提交的业务账本。
5. 用同一前缀和 D1 ID 重新生成 `workflow` 配置；核查绑定没有变化，`feed-jobs` 对应的本次演练队列不再设置两消费者上限。打包并部署新执行方式，恢复该独立 Queue 的投递。五分钟 Cron 始终关闭。额外触发一次 `delay`，观察启动消息当时已发出、计划时间前无 Workflow 接手，到点后才进入实际抓取。可在另一轮单独触发 `rate`：合成源在指定时刻前返回 429 与绝对日期 Retry-After，读回同一个 Workflow 的步骤和最终 R2 原件，以实际时刻验证重试。
6. 用 `journal` 读取这些任务的原始列表记录。对于三个不同站点各一次实际请求，应满足 `max(开始) < min(结束)`；同站相邻请求则应满足 `前一项结束 <= 后一项开始`。核对每项旧积压沿用原 ID、仅一份成功结果；比对已有版本、事件、游标、失败原因和尝试次数，并再次读取原件核对哈希。
7. 导出不含凭据的对照结果。移除**本次创建**的临时 Worker、容器应用、镜像标签、Queue、D1 和测试桶及其中的测试对象；以创建回执标识资源，不按前缀批量删除。未取得真实记录的项目列为未验证。

`probe` 只构造有固定输入的演练任务和启动消息。它不能接受任意 URL、决定业务状态或代替采集 Workflow。它的 `queue` 入口记录投递时间，再调用生产消费者；正常存档和交接结果由业务路径生成。既有版本与历史错误是用来验证不变性的夹具，不计为本次采集生成的版本。
