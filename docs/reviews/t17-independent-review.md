# T17 独立复核记录

日期：2026-10-13（北京时间）。本轮覆盖逐任务审查后云端验收产生的修复，固定范围为 `6c540d9e9d27a40411b98caf90f01bc06c5aaa56...560d4a98b5086de3383c234532e2a131d37d48f9`，21个文件。T01–T16逐任务审查保留原记录，本轮不冒称重新逐行审阅全部正式版代码。

Standards与Spec由两个独立子代理并行审查；用户告知GLM5.3可用后，已以`zhipu/glm-5.3`、`max`成功启动独立证据核对及单独修复代理。Main负责核对历史代码、审阅修复与集成，不把Main自查计作独立复审。

## Standards

初审1项P2：旧capture journal没有`migrationSemanticFingerprint`时，直接用含占位文本的`capture.body`比较带原生PDF文本的迁移基线，会误判实质修改。要求从已保存的原件和正文恢复比较依据，保持持久重放，不重新付费抓取/OCR。

## Spec

初审1项P1：未变的混合PDF，首次新采集的兼容指纹与旧占位型基线表示不同，可能生成虚假更新。历史代码核对确认`7fb8e2a`的MVP会追加混合PDF原生文字，而`6c540d9`旧路径会使用占位文字，两种基线均需支持；不能只改为其中一种。

## 证据核对

GLM确认1项P2：OCR诊断直接展示预算行中的日/月页数，未检查预算行对应周期，跨UTC日/月后可能显示上期值。预算执行会在下一次预留时重置，累计已处理页数也无重复扣费，但诊断输出需纠正。

Queue归属最初缺少授权清单；补充原始Wrangler清单后独立确认jobs48、events81、mail6，共135。另66次属于`schedule-sync`，不是T17。原GraphQL请求、时间边界与结果分文件保存的证据也已核实，未发现报告把计划、本地测试或未到时的摘要写成真实验收完成。

## 修复与复审

修复为签名提交`d56a1e317ebc884318cba5187091060445be35a3`，父提交正好是`560d4a98b5086de3383c234532e2a131d37d48f9`。已在同一SHA完成独立复审并快进合入`feat/production-v1`；真实20:00摘要仍是另一项待验门槛。

迁移比较从capture保存的raw body及PDF原件重建native表示，同时兼容旧占位表示，保持旧基线与journal不变。必要证据不足时进入已有deferred恢复路径，不提交猜测的版本分类，不重新抓取或OCR。回归通过真实Worker历史/事件接口验证：完成check-ready后无虚假更新；真实正文修改仍产生update。另覆盖旧journal缺字段、首次PDF读取中断以及证据恢复前后scrape次数不变。OCR诊断覆盖同周期、跨UTC日、跨UTC月，读取不改写预算。

完整本地命令`pnpm --config.verify-deps-before-run=false run ci`通过：203项测试、TypeScript/Vite构建、设计规则和Worker dry-run。`git diff --check`通过，提交使用仓库现有Git身份并验证签名。原始日志已复制至本会话交付目录`t17-review-fix-evidence/`。

初审运行本地测试时受到`127.0.0.1 listen EPERM`限制，没有进入业务断言；不把这算作产品失败或测试通过。修复与复审使用获准的本地Miniflare执行，断言实际通过。

红绿证据区分：mixed初次比较、旧journal重放、UTC周期诊断各有业务红灯；缺比较证据的deferred路径也有失败后修复记录。`archive-native-read-red.log`是fixture缺迁移表导致的失败；补齐后`archive-native-read-red-2.log`实际为通过，文件名不代表业务红灯。

| 独立复审 | 结果 | 独立执行的验证 |
| --- | --- | --- |
| Standards | 原P2关闭，无新增发现 | 迁移＋运维27/27、diff检查通过 |
| Spec | 原P1关闭，无新增发现 | 迁移＋运维27/27、版本＋复查10/10、diff检查通过 |
| GLM5.3证据/诊断 | 原P2关闭，无新增发现 | 运维11/11、diff检查通过；未冒称复跑完整CI |

Standards与Spec分别保留结论，不合并重排严重性。三位复审代理均未修改候选源码、调用供应商或接触生产数据。

修复提交的[远端CI38329786882](https://github.com/cqu-moe/feed/actions/runs/38329786882)已成功。Main核对返回的`headSha`正好是`d56a1e317ebc884318cba5187091060445be35a3`；集成worktree重新构建，并使用T17专用配置完成打包预检。修复临时worktree已移除，分支/提交保留，18份日志已校验归档。

Main随后将同一源码部署至隔离Worker`cqu-feed-t17-20261013`，版本`68d10467-cee8-4318-bfa0-435101a160cf`。09:06北京时间健康及诊断均200：UTC当日OCR0、本月3、累计3，供应商调用15未增加；账本仍只有此前两封delivered即时邮件，各attempt1。源码复审、CI和实际部署读回分别留证，未用它们代替今晚真实摘要。

初审完整报告和探针保存在本会话交付目录：`feed-t17-standards-review.md`、`feed-t17-spec-review.md`、`feed-t17-evidence-review.md`；原始验收收据仍在Git忽略的`.private/t17-receipts/`，不发布凭据、私有RSS或会话。
