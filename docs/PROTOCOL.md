---
name: Vault Memory Protocol
description: 宿主中立的 Second Brain vault 读写协议
type: reference
audience: [agents, maintainers]
---

# Vault Memory Protocol

本协议定义任何 AI 助手或自动化如何读取及建议写入 Second Brain vault。vault 根目录由 `BRAIN_VAULT_ROOT` 指定。
本仓库另提供本地 CLI/MCP 记忆接口，见 [MEMORY-INTERFACE.md](MEMORY-INTERFACE.md)；它复用本协议的
writer，不改变 Markdown 真源和受管写入边界。

## 1. 读取

全部文件可读。优先从宿主维护的轻量索引开始，再按 type 路由到 vault 分区，最后用标题词与领域词宽泛检索。索引和语义数据库都是可重建投影，vault 文件才是真源。

## 2. 写入

具备本机执行权限且已获授权的宿主一律调用：

```bash
node "$BRAIN_VAULT_ROOT/00-系统/scripts/cli/brain-write.mjs" \
  --source <host-id> \
  --type <type> \
  --title <title> \
  --description <description> \
  --provenance <evidence>
```

正文从 stdin 或 `--body` 传入。管道负责 section policy、查重、索引更新与台账。编辑器、重定向或自定义脚本直接写记忆 Markdown 都属于绕过管道。

写入、`--dry-run` 与 `--show-route` 回执均给出 `recall_state`。`pending_classification` 表示内容保存在 `99-inbox/` 原文中，尚未进入默认热记忆、领域索引或意图关键词；需通过受管入口重新指定已有合法分类，系统不会自动搬迁。`excluded_default_recall` 表示对话或观察原文保留，但不进入默认热记忆。

目录级 sandbox 不能阻止授权目录内的裸写，因此完整性同时依赖调用约定、写入台账和外部控制面的审计。外部 guard 不包含在本仓库中。

### 受管维护

维护由 Agent 经同一 writer 完成，不要求用户手工清文件。所有命令须给 `--source` 和 `--reason`：

- `--reject-clip <timestamp>`：拒收 pending 剪藏，保留快照及原图，observe 跳过拒收标记。
- `--revise <note> --expected-sha256 <sha> --body <正文>`：原地替换正文，保留其余 frontmatter；可用 `--description` 同步更新摘要与索引。
- `--deactivate <note> --expected-sha256 <sha>`：保存恢复记录后停用笔记，并移除活动索引项。
- `--rename <note> --new-title <标题> --expected-sha256 <sha>`：同目录改名，同时更新 name/title、可唯一解析的 wiki/Markdown 路径链接和活动索引；先加 `--dry-run` 可查看所有受影响路径与前后哈希。
- `--restore <operation UUID>`：撤销一次修订、停用或改名；`--resume-maintenance <operation UUID>` 继续一次中断操作。

恢复记录保存在 `raw/processed/brain-write/`，不作为 Markdown 记忆摄取，不自动永久清理；同步时须排除此目录。操作先核对完整写入集合，再逐项核对：第三方更新会阻止重放，备份仍保留。

改名限单篇活动 Markdown，扫描 01–05、07–09、99-inbox 的 Markdown、根与项目 `_index.md` 及已声明热/分域索引。保留正文普通文字、代码、链接别名与锚点、附件和历史台账；不扫描归档、原始资料及恢复材料。新标题不含路径、`.md` 后缀或链接分隔符。拒绝已有目标、大小写或 Unicode 等价名称、同名歧义、软/硬链接及不可解码文件；相关引用若使用 frontmatter、引用定义或 HTML 属性等未支持形式，停止并报告文件。跨目录移动、目录或批量改名不在本版范围内。

改名先持久化 v2 恢复记录，再创建新笔记、逐项更新引用，最后撤下旧活动路径；多文件操作不是瞬间原子化。被替换的实际文件也永久保存在同一恢复目录的 `.retired` 文件中，未写完的临时内容保留为 `.incomplete`。操作 UUID 绑定临时文件；续做核对 inode、内容哈希及完整写入集合，收尾再核对全部终态才记成功。中断后由 Agent 续做，撤销按相反顺序执行。检索投影通过已有受管 watcher 异步刷新；文件写入成功不能单独证明检索已经同步。

剪藏原件保存在 `raw/processed/clip-originals/`，编码错误元数据保存在 `raw/processed/clip-encoding-errors/`，均永久保留且不作为 pending 消费，与维护快照复用 `raw/processed/` 的备份与摄取排除规则。集成检索器时必须排除此目录，避免未审原文和错误元数据进入活动记忆。pbpaste 固定 UTF-8；HTML 编码不明确时保留原始字节，只使用能核对为同一剪贴板事件的纯文本，不猜 GBK。原件保留失败不提交处理状态，以便重试。

只读宿主，或遇到路由不清、敏感内容、需要合并既有记忆时，使用提议通道：

```xml
<memory-propose type="feedback|project|reference|user-profile|experience" title="人类可读标题" projects="可选项目名">
一句规则或事实。
Why: 原因。
How to apply: 适用场景。
</memory-propose>
```

维护者查重并逐条决定写入、跳过或编辑。普通任务输出、可从代码推导的信息、临时状态和未验证推测不应沉淀。

### 本地接口的写入边界

`brain.mjs` 的 `remember`、`revise`、`forget`、`restore` 和 `loops_close` 都是整篇 note
粒度的受管 writer 操作。变更现有 note 时须提交当前完整 SHA-256 作为 CAS 前提；停用可恢复，原始
内容保留在 writer 的恢复材料中。接口不提供 OAuth、远程租户隔离或后台邮箱同步；已配置的 connector
只能由 Agent 显式读取，再将可归因内容交给 writer。

## 3. 分区边界

| type | 默认位置 | 约束 |
|---|---|---|
| `experience` / `feedback` | `03-经验/{subfolder}/` | 跨项目可复用经验 |
| `project` | `01-项目/{project}/` | 必须绑定已登记项目 |
| `reference` | `02-知识/{subfolder}/` | 稳定参考知识 |
| `session` | `04-对话/` | 项目范围 |
| `user-profile` | `05-persona/` | 个人数据，默认本地 |
| `observation` | `08-观察/` | 未确认过程材料，不作事实引用 |
| `weekly` | `09-周报/` | 周期回顾 |

## 4. 安全边界

- 不绕过 `brain-write.mjs` 写记忆。
- 不裸删或永久清理记忆；修订与可恢复停用走上述受管命令。
- 凭证、密码和密钥不得进入 vault、日志、模板或 git 历史。
- `00-系统/` 的代码发布由 `scripts/publish.mjs` 管理，不属于记忆写入。
- Publisher 是高权限例外路径，首次真实发布前必须完成独立只读安全复核。

## 5. 发布失败后的受管恢复

发布返回 `rollback-failed` 时，部分脚本可能已更新，服务保持停止，第三方改动与发布备份保留。Agent 先读取回执所指备份目录中的 `recovery.json` 并核对冲突，再调用 `node scripts/publish.mjs --recover <backupDir>`；恢复成功后运行 `node scripts/publish.mjs --check` 并核对服务状态。`install.mjs recover` 只诊断安装状态，不能替代发布器恢复。

若目标出现不同于备份前后版本的第三方内容，受管恢复会拒绝覆盖。Agent 应报告具体文件及差异，保留内容和备份，待内容取舍明确后继续；不要求用户手工移动文件，也不自动清空快照或孤儿附件。
