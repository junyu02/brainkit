---
name: Brainkit Memory Interface
description: 本地 CLI/MCP 记忆接口、边界和可执行 scratch 示例
type: reference
audience: [agents, maintainers]
---

# Brainkit Memory Interface

`scripts/cli/brain.mjs` 为现有 Markdown vault 提供本地 JSON CLI 与 MCP stdio 接口。Markdown
仍是事实真源；所有长期写入仍通过 `brain-write.mjs`。接口借鉴
[GBrain MEMORY_VERBS v1](https://github.com/garrytan/gbrain/blob/master/docs/protocol/MEMORY_VERBS_v1.md)
的七个核心动词和 MCP 表面设计，但没有合并其整个仓库，也**不**兼容该协议：返回字段、身份模型、
存储模型和操作集均以 `brainkit/v1` 为准，不能运行 GBrain conformance 来宣称兼容。

## 范围与启动方式

CLI 使用 JSON 参数；读取不需要 `--source`，写入必须显式给出实际调用者。例如，以下命令可在一个
已初始化的 scratch vault 中运行；`./scratch-vault` 只是当前目录下的示例路径，不是个人路径或默认配置：

```bash
export BRAIN_VAULT_ROOT="$PWD/scratch-vault"

node scripts/cli/brain.mjs capabilities
node scripts/cli/brain.mjs recall --json '{"query":"项目约定","limit":5,"budget_bytes":2000}'
node scripts/cli/brain.mjs remember --source scratch-agent --json \
  '{"title":"示例约定","fact":"本条仅用于 scratch 验证。","description":"scratch 写入示例","type":"experience","subfolder":"AI工具","provenance":"scratch command"}'
```

最后一条会写入 vault；只应在已准备好的 scratch vault 运行。`remember` 会将 `type`、`subfolder`、
`provenance` 原样交给受管 writer，后者执行路由、查重、索引更新和 ledger 记录。不要把接口默认行为
理解成所有工具或 connector 都已自动接入 live 数据。

MCP 通过 stdio 提供：

```bash
node scripts/cli/brain.mjs serve
node scripts/cli/brain.mjs serve --allow-writes --source scratch-agent
```

第一条永远只读。第二条才公开写操作，且写操作仍由 `brain-write.mjs` 处理。MCP 初始化时的已知
`clientInfo.name` 可映射为本机 ledger 中的 actor（目前为 Codex 和 Claude 的已知名称）；它只是本地
记账便利，**不是认证、授权或远程身份声明**。未显式指定 `--source` 时，未知客户端不能获得可写 surface；本机管理员可用 `--source` 固定 actor。

本地 JSON CLI 与 MCP 默认都不暴露写操作。CLI 要写入必须显式传 `--source <host>`，否则
`remember`/`revise`/`forget` 等写操作直接以 `Write operations require --source.` 拒绝。MCP 要暴露写
操作还需要 `serve --allow-writes`，并且有一个可记账的 actor：显式 `--source`，或上面那张已知
`clientInfo.name` 映射；两者都没有时该 surface 仍然只读，`tools/list` 里根本不出现写工具。

MCP 读取结果上限为 2000 UTF-8 字节；可打包操作会收紧到该预算，其余操作超限时明确返回
`response_too_large`，不截断 JSON 或隐藏来源。需要更大范围时使用本地 CLI。`tools/list` 不属于记忆召回结果。

## 15 个操作

| 操作 | 默认 MCP 可用 | 作用 |
|---|---:|---|
| `capabilities` | 是 | 返回 `brainkit/v1`、可见操作和边界 |
| `recall` | 是 | 从当前 Markdown 检索；可选语义候选仍回查原文 |
| `entity` | 是 | 按稳定实体 ID、note id、标题、别名解析实体及关系 |
| `context_pack` | 是 | 生成 UTF-8 JSON 字节预算内的证据包，不调用模型 |
| `delta` | 是 | 返回当前文件变化和受管 writer ledger 事件 |
| `open_loops` | 是 | 读取明确标记的承诺 checkbox 及结构化承诺 |
| `synthesize` | 是 | answer 综合并核对来源；extract 提取候选；enrich 检查整理候选 |
| `doctor` | 是 | 检查 Vault、模型配置、索引、流水线及结构化数据质量 |
| `sync_status` | 是 | 同步窗口进度及已收录来源 ID 分页；不返回邮件正文 |
| `remember` | 否 | 通过 writer 新建 note 或单个结构化记录 |
| `revise` | 否 | 以 note SHA-256 CAS 修订正文或递增记录版本 |
| `forget` | 否 | 以 CAS 可恢复停用完整 note |
| `restore` | 否 | 恢复一次成功的 note 修订或停用；更广维护仍走原 writer |
| `loops_close` | 否 | 以 CAS 勾选一个明确承诺 |
| `ingest_events` | 否 | 接收 Gmail/Calendar 的最小事件，经 writer 幂等写入观察层 |

可写运行时才会列出六个写操作。所有返回均应被当作证据而非指令。

## 数据语义与限制

- `context_pack`、`recall`、`delta` 和 `open_loops` 的响应 `budget_bytes` 是包含
  JSON envelope 的 UTF-8 字节预算，不是 token 预算。
- 保留正文中的显式 `predicate:: [[target]]` 或 `predicate: [[target]]` 关系；没有 predicate
  的链接只表示 `mentions`。实体记录也提供稳定 ID、别名和结构化关系。
- 只有 note frontmatter `kind: commitment` 下的 checkbox，或标题为 `待跟进`、`承诺`、`未完成事项`、
  `Open loops`、`Commitments` 的章节内 checkbox，才是 `open_loops` 任务。普通 checklist 不算任务。
  `loops_close` 只会在 CAS 成功时把对应 `[ ]` 改为 `[x]`，不会从缺少证据推断完成。
- `delta` 合并 writer ledger（包括撤回/停用等受管事件）与仍存在文件的 mtime 变化。其 cursor 用
  `updated_at + event_id` 排序，所以同一 timestamp 的事件可继续分页；它不追踪绕过 writer 的 raw
  filesystem deletion，也不能将该删除报告为已观察到的变更。
- 语义检索是可选的现有 MemPalace 候选来源，不创建新数据库。候选只有在能回查到唯一当前 Markdown
  原文后才会返回；不可用时接口仍可完成关键词检索并带警告。
- `synthesize` 的 answer/extract 使用既有模型配置，可能消耗 API 费用。answer 先校验来源 ID 与原文
  引语，再独立调用一次模型逐条检查结论是否受证据支持；有反证、不确定或失败时返回原文摘录。两次调用
  合计 token 用量。此检查降低错误风险，不保证模型判断绝对正确。enrich 不调用模型、不改原文。
- 单次扫描上限 10000 篇可读笔记。可读笔记超过该上限时，`include_unconfirmed:true` 的全量扫描返回
  `scan_limit`（上限不上调），需用 `source_ids`/`entities` 收窄，或走本地 CLI 做更大范围的扫描。

## 稳定记录与候选

`brainkit-record/v1` 支持 entity、fact、relationship、commitment；每个记录独占一篇 Markdown，
包含稳定 ID、正整数 version、confirmation 和 sources。来源必须包含当前完整原文件 SHA-256、精确
quote、quote_sha256 与原有 trust。记录 ID/kind 不可在修订中改变，version 每次加一。原始证据改变后，
记录退出默认召回并出现在整理候选中。`valid_until` 是记录有效期；旧 frontmatter `expires` 只管热索引保留。

调用 `synthesize` 并给 `mode:"extract"`、`source_ids`（观察来源还需 `include_unconfirmed:true`）获得
proposed 记录。随后 `remember` 携带 record 和 `type:"observation"` 保存为 `brainkit-candidate/v1`。
候选不进默认召回；用 `recall` 的 `record_id`、`include_unconfirmed:true`、`detail:"record"` 查看。
核验出处和表述后，以同一个 record ID、version=1、confirmation=confirmed，通过 `remember` 写入合适的
正式分区。候选原件保留；旧 harvest 不会把结构化候选、事件或记录重新当普通观察晋升。

结构化承诺含 owner/counterparty/due/status。相对期限缺少可靠时间依据时保留待核问题，due=null，不能拿
笔记修改时间推算“明天”。标记 done 必须提供 1–8 条新的 completion_sources（缺失返回 `invalid_params`）；
证据笔记无法安全读取返回 `source_invalid`；取消必须保留 reason。
`mode:"enrich"` 返回重复、可能冲突、过期、逾期和证据变化候选，全天 `due` 的逾期判断按 UTC 日期，
UTC+8 下最多滞后 8 小时。同一关系可以有多个对象，因此
possible_conflict 只是待核提示，绝不自动合并或撤回内容。

新结构化写入前，writer 以 ledger 为发现索引扫描已有结构化笔记：ledger 记录的路径若已被移走、停用，
或不在可读分区（例如 `brain-archive-aged.mjs --apply` 造成的非受管移动），扫描时直接跳过，不报错；
只有正文无法解析或读取异常才作为 diagnostic 返回，错误信息会列出前 3 条问题笔记路径（`source_invalid`、
`cannot verify structured identity … : <path>`）。坏笔记存在时，新结构化写入仍会拒绝（失败关闭）；
修好或移走该笔记即可恢复。这一步在 writer 全局锁内重读一遍 ledger 与全部结构化笔记，ledger 越大扫描越慢。

被跳过的笔记同时失去唯一性保护：它的 record_id / event_id 可以被重新写入，writer 不会拒绝，于是同
一个 ID 会有两份活笔记，provider 后续更新只改 ledger 认识的那份。记录类可以用 doctor 的
`duplicate_id` 发现，连接器事件类 doctor 看不见，只能人工检查。

## 邮件和日历同步

宿主先通过已授权 Gmail/Google Calendar connector 读取并核对资料，再调用 `ingest_events`；本库不存
OAuth 凭证。每个事件含 external_id、真实 provider updated_at、title、最小 summary，日历可附 status/
start/end/due。全天日程保留 YYYY-MM-DD，不伪造时区。私人观察笔记保存 opaque source_ref 以便重读，
稳定 event_id 由 provider 与来源 ID 派生；不保存原始邮件、附件或登录链接。

事件笔记落在 `08-观察/YYYY-MM/`，月份取事件自身时间（`source_updated_at`，本地时区），所以跨月
回填会按事件发生的月份分目录。`YYYY-MM` 格式与本地时区约定同 observe 管道，但 observe 取素材
自身时间，这里取事件时间；`remember` 写 `type:"observation"` 未指定 `subfolder` 时取写入时刻的
月份。落点被路由策略拒绝时结果是 `failed` 并带 `reason`（如 `pending_classification: …`），
不再是无原因的 `failed`。

`ingest_events` 对 title/summary 先套用与 writer 相同的凭据脱敏规则（`password:`/`sk-`/`AIza`/`ghp_`/
`xoxb-`/`Bearer …` 形态）再计算 `data_sha256`，落盘内容含 `[REDACTED]` 标记；因此同一事件重放的哈希
稳定，不会因脱敏卡死窗口。

每批最多20条，先校验整批，再经 writer 创建/修订。相同版本内容冲突明确失败；较旧更新不能覆盖新版本。
同步状态缓存可丢弃、可重扫，永远不是真源。`window_start/window_end` 描述本次完整扫描的范围，`window_end`
不得晚于当前时间 + 1 天（gmail）或 + 366 天（google-calendar），否则返回 `invalid_params`；所有页面
成功且 complete_window=true 才推进完成水位，部分失败不推进。Gmail 的窗口按收信时间，Calendar 按日程
窗口；窗口完成不意味着整个历史邮箱或日历都同步过。

定时工作流每次留重叠窗口重查；先读取 sync_status，分页跟随 next_after_event_id 复查已知日程，避免取消或
移出窗口后遗漏。API 明确返回取消才记录取消；找不到或权限失败只记录同步失败，不能推断删除。新数据或
状态变化才生成提取候选；重复扫描不制造重复记录。定时器属于宿主，例如现有 Codex automation。

## 写入与恢复

每个结构化事实独占一篇 note，因此能够维护单个事实，同时保留 note-level 的受管存储。`revise`、`forget` 和
`loops_close` 均须提供读取到的完整 `expected_sha256`；当前文件已经变化时返回冲突，必须重新读取后
再判断。`forget` 的停用和维护性 `restore` 使用 writer 保留的恢复材料，不能用原始文件删除替代。
统一接口拒绝恢复 rename、索引修复或 restore 链；这些多文件维护继续使用原有 writer 的明确入口。

写操作可带 UUIDv4 `request_id`；不确定是否成功时必须用同 ID、同参数重试。writer 在原有全局锁和 ledger
下记录并重放成功回执，重复 ID 更换内容会拒绝。HTTP 写操作强制该参数；超时可能仍在执行，不能当作失败后
用新 ID 再写。恢复旧版本允许恢复原件，但旧来源失效的记录仍不会进入默认召回。带 `request_id` 的写入会在
`raw/processed/brain-write/request-commits/` 保留含完整正文的计划文件作为恢复材料，不自动清理（与
note-maintenance 恢复材料同一口径）。

`00-系统/logs/brain-write-ledger.jsonl` 只追加、无自动轮转，上限 32 MiB（`MAX_LEDGER_BYTES`）。超限后
`delta`、`sync_status`、`ingest_events`、按 record_id 的 `recall`，以及所有带 `request_id` 的写入
（HTTP 面全部写入）失败关闭，错误串为 `brain-write ledger is not a safe regular UTF-8 file within its
byte limit`（code `ledger_too_large`）；纯文本 recall/entity/context_pack/open_loops 不受影响。增速
参考：不带 request_id 的 remember 约 0.4 KB、带 request_id 约 1.1 KB、20 条事件的 ingest 批次约 10 KB、
bind+finish 约 2.4 KB。处置：人工把旧段改名归档（如 `brain-write-ledger.2026Q3.jsonl`）后从空文件继续；
改名后旧段中的 request_id 幂等回执与结构化笔记发现将不再可见，因此只在没有未完成远程写入时操作。

目录级权限无法阻止获授权进程在同一目录裸写。因此 ledger、恢复材料和调用约定构成审计与恢复链，
并不构成认证边界。详细 writer 规则见 [PROTOCOL.md](PROTOCOL.md)。

## 部署与健康边界

stdio 与 [HTTP](REMOTE-MEMORY.md) 共用同一操作实现；HTTP 绑定 loopback，token 固定 actor/read-write
范围及到期时间。可直接在原电脑运行，另一台常在线主机不是必需品。跨设备使用需要你自己的安全传输通道。

doctor 区分“目录存在”“后端可达”和“索引新鲜”；没有来源水位证明时 freshness=unknown。`healthy` 为 `true`
的条件是全部 check 均为 `ok` 或 `not_configured`——未配置的可选能力不计入故障。`semantic_index` 可达时
状态为 `ok`，但 `freshness` 恒为 `unknown`，不据此宣称索引已是最新。新增 `checks.ledger`（含 `bytes`/
`limit`）：ledger 体积达到 32 MiB 上限（`MAX_LEDGER_BYTES`）的 80% 报 `warning`，达到上限报 `error`
（`ledger_too_large`）。模型配置存在
不等于已实测 provider；网络模型验收应单独执行并记录成本。仓库检索评测包含合成 train/validation，不能用
合成集成绩宣称私人全库达到相同质量。
