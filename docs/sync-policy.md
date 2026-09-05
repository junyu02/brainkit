# Vault Sync Policy

启用任何同步客户端前，先按内容而不是目录名判断风险。

| Layer | Status | Reason |
|---|---|---|
| `00-系统/` | CONDITIONAL | 代码和公开模板可同步；logs、`.index-cache/`、真实配置和运行态不可同步。 |
| `01-项目/` | CONDITIONAL | 可能包含私有项目上下文。 |
| `02-知识/` | SAFE | 适合长期参考，但仍应检查版权和来源限制。 |
| `03-经验/` | CONDITIONAL | 可能包含项目路径和故障上下文。 |
| `04-对话/` | LOCAL ONLY by default | 可能包含对话、代码和个人工作模式。 |
| `05-persona/` | LOCAL ONLY | 包含个人画像。 |
| `06-归档/` | CONDITIONAL | 继承来源分区的分类。 |
| `08-观察/` | LOCAL ONLY | 自动采集的过程材料。 |

必须排除：

- `.obsidian/workspace*.json`
- `.obsidian/cache/` 和插件二进制
- `00-系统/logs/`、`00-系统/.index-cache/`
- `raw/`、attachments、assets 和媒体文件
- `*.env`、真实配置、凭证和密钥
- iCloud conflict copies

Git remote、云盘和同步服务的可见性决定实际风险；私有仓库也不等于凭证存储。同步前检查条件分区、远端访问控制和历史版本保留策略。
