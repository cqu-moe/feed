# 通知搜索：审查、联调与回滚

[规格与五项子任务](https://github.com/cqu-moe/feed/issues/77) · [数据范围及费用口径](specs/bailian-notice-search.md)

仓库默认 `BAILIAN_SEARCH_WRITES=false`、`BAILIAN_SEARCH_READS=false`。本 PR 不开库、不部署。通知页的部门、栏目和发布日期可独立用于 D1 浏览；百炼启用后只有提交搜索词才调用远端。短词不会触发第二次 D1 全文扫描。回滚到旧搜索则恢复旧实现，包括旧短词匹配的成本特征。

## 先在本地看读者路径

安装仓库锁定依赖后执行 `pnpm exec playwright test tests/browser/bailian-notice-search.spec.ts --headed`。用例在现有通知页提供合成通知和模拟会话，覆盖搜索、筛选与故障返回。Worker 侧执行 `node --test tests/bailian-*.test.mjs`；D1、R2 使用本地模拟器。它们能验证文档提交与返回的处理，不能证明远端的中文召回效果。

## 真实环境的前置条件

1. 在独立的北京验证空间创建私有标准版文档知识库和专用文件类目。知识库选内置存储、`text-embedding-v4`；发布只绑定该库的检索服务，配置关键词和向量双路召回、`qwen3-rerank`；建议各取 20 段、最多返回 20 段。在知识库的 `index_config.fields` 声明标签可过滤，不添加会收窄语料的离线过滤条件。[接口约束](https://help.aliyun.com/zh/model-studio/knowledgesearch)。相应模型、配额、筛选能力在目标账号中核对。应用本身不创建库、不请求文本生成。
2. 给验证 Worker 配置 `BAILIAN_WORKSPACE_ID`、`BAILIAN_CATEGORY_ID`、`BAILIAN_INDEX_ID`、`BAILIAN_SEARCH_SERVICE_ID`。同一空间授权的 `BAILIAN_API_KEY` 只入 Worker Secret，不放浏览器、不写入 Git。生产配独立类目和库；有待清理文件时不能直接修改这些 ID 指向另一套资源。
3. 在验证环境应用 `0022_bailian_search.sql`，先保持读写关闭。准备脱敏样本：一篇普通网页、一篇仅有正文 PDF 的通知（第二页有唯一金额）、一篇包含可读 PDF 和无字扫描附件的通知。包含一个已完成旧档、一篇双栏目、一个未知发布日期。回填前先核定数量与预算：库基础时长 + 实际入库嵌入 token + 查询嵌入与送排片段 token。实际账单以空间用量为准；关闭请求不会停止库的基础费。
4. 在隔离验证环境先开写、保持读关闭；确认上传和**逐文件**导入就绪，再开读。搜索「补考」、同义问法、PDF 独有金额；核对一个只有在指定栏目才能进入前列的样本、日期边界、跨栏目去重、PDF 原页；无日期通知只能在无日期筛选时命中。不做性能排名。
5. 修改同版本 OCR 的金额并切换版本，试查新旧金额；重复执行同步，检查旧文件不再返回、未新增通知或邮件。模拟百炼限流时搜索须可重试、空词仍可浏览。最后验证未登录、撤销阅读权和正常账号三条路径。上述真实账号操作未执行前，不把本地检查写成云端验收通过。
6. 放行顺序为验证库 → 小批真实样本 → 核对覆盖后回填 → 切读。需要撤回时先关 `BAILIAN_SEARCH_READS` 恢复旧列表入口，再关 `BAILIAN_SEARCH_WRITES` 停止后台远端写入。保留迁移表与远端回执以便恢复，原始 D1/R2 存档始终保留；最终退役需另行确认后才删除专用云库和类目。

## 管理员操作

以 `feed.admin` 会话访问 `GET /internal/operations/notice-search`：`readable` 是全量可读通知，`notices` 是已登记通知的状态分布，两者之间的差额代表尚未盘点的历史通知。`originals` 分列网页正文、正文 PDF、普通 PDF 原件数和字节数，可在开写前盘点；原件字节不是送入模型的 token 数。查看 `files` 的状态、阻塞原因与数量，`needsAttention` 列出需处理的前 20 个文件及其本地／远端回执，`blockedCleanup` 是被阻塞的清理数。`cleanup` 为已失效的待清理文档数，`usage` 为最近七天后台操作次数。它们不是已计费 token 数。搜索只记录结果数量或故障类型，不写入原始查询和命中片段。

向同一路径发同源 POST，JSON 为 `{"action":"start-backfill"}`。支持 `start-backfill`／`pause-backfill` 控制历史清单游标；`pause`／`resume` 控制整个后台任务（已在途的操作可以完成）；`retry` 在修正配置后重试可安全重放的阻塞项。写入开关关着时不会访问供应商。后台用短批次推进，所以“已登记”不等于“可搜索”。

若标记 `unconfirmed_receipt`，表示远端可能已受理但本地没有可靠回执，不要重复上传／发起导入。暂停同步，在专用类目按本地待处理记录的确定性文件名 `feed-<id>.md` 查找并核对文件、导入任务，再恢复回执；真实修复须经管理员核实。上线前验证申请租约、按文件导入／删除、分组标签 AND/OR 语义，以及测试资源是否产生基础费。

恢复 D1 到 0022 迁移以前会丢失文件和任务回执。先关闭读写、保留回执备份并完成清理；如已丢失回执，必须在专用百炼类目和库逐项核对遗留文件，仅恢复 D1 不会清除云端资源。
