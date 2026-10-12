# Domain Docs

本仓库采用 **single-context**：根目录 `GLOSSARY.md` 与 `docs/adr/`。`pnpm-workspace.yaml` 目前只包含根包，不建立多 context 布局。

## Before exploring

- 先读根目录 `GLOSSARY.md`，使用已定义的领域用语。
- 阅读 `docs/adr/` 中与本次工作相关的决策；不存在时静默继续，由 `domain-modeling` 在实际形成决策时按需创建。
- 正式版设计从 `docs/production-design.md` 进入，再按任务读取 `docs/architecture/`。区分用户已确认规则、技术提案与已实现事实，设计稿不代表生产已实现。

## Consumer rules

issue 标题、规格、实现和测试都沿用术语表用语。缺少术语时先判断是否是必要概念，确有缺口再交给 `domain-modeling` 补充。

若提案与既有 ADR 冲突，指出具体 ADR 与重新讨论的理由，不能悄悄覆盖。`codebase-design` 使用 Module、Interface、Seam、Adapter 描述工程结构；这些工程术语不替换 Feed 的领域术语。

无需预先创建空的 ADR、GLOSSARY-MAP 或分 context 目录。已有术语表保留，形成实际决策时再记录相应文档。
