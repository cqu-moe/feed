# Issue tracker: GitHub

本仓库的任务和需要发布的规格使用 GitHub Issues：`cqu-moe/feed`。使用 `gh` CLI，并显式传 `--repo cqu-moe/feed`，避免在父目录或其他 worktree 操作错仓库。

## Conventions

多行正文先写入 UTF-8 临时文件，再传 `--body-file`；不要把正文插入 shell 命令字符串。临时正文不提交到仓库。

- 创建：`gh issue create --repo cqu-moe/feed --title "..." --body-file <file>`。
- 读取：`gh issue view <number> --repo cqu-moe/feed --json number,title,body,labels,comments`。
- 列表：`gh issue list --repo cqu-moe/feed --state open --json number,title,body,labels`；按任务加标签过滤。
- 更新正文：`gh issue edit <number> --repo cqu-moe/feed --body-file <file>`。
- 评论：`gh issue comment <number> --repo cqu-moe/feed --body-file <file>`。
- 标签：`gh issue edit <number> --repo cqu-moe/feed --add-label <label>` / `--remove-label <label>`，映射见 `triage-labels.md`。
- 关闭：先按需要发布完成依据，再执行 `gh issue close <number> --repo cqu-moe/feed`。

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill instructions

技能说“publish to the issue tracker”时，将相应内容发布为 GitHub issue；说“fetch the relevant ticket”时，读取对应 issue 及相关评论。仓库中的设计文档仍是实现依据，发布 issue 时链接到相关文档和明确的验收条件。

## Parent tasks and blocking

当前已检查本机 gh 2.100.0 支持以下命令：

- 子任务：创建时加 `--parent <number>`；已有任务用 `gh issue edit <child> --repo cqu-moe/feed --parent <parent>`。
- 依赖：创建时加 `--blocked-by <numbers>`；已有任务用 `gh issue edit <child> --repo cqu-moe/feed --add-blocked-by <blocker>`。
- 认领：`gh issue edit <number> --repo cqu-moe/feed --add-assignee @me`。

其他环境先检查 `gh ... --help`。若原生关系不可用，在子任务正文保留 `Part of #<parent>` / `Blocked by: #<n>`，父任务用 task list 反向链接；不可只记录依赖而不检查 blocker 是否关闭。

`wayfinder` 使用单个 map issue 和 child issues，map 保存 Notes / Decisions-so-far / Fog；`wayfinder:map` 和 `wayfinder:<type>` 标签在实际使用该流程时按需创建。Frontier 是 map 中尚未关闭、未被认领且无未解决 blocker 的任务，按 map 顺序选择。完成后记录结论、关闭 child，并更新 map 中的决策指针。
