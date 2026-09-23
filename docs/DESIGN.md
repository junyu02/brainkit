# Design

brainkit 是“开了源的私人系统”：代码按可公开标准组织，但维护者仍是唯一生产用户。仓库以 MIT 许可证开源，不承诺支持、稳定性或通用可配置性；部分默认值仍编码了维护者本人的环境。

## 架构

repo 是代码、模板和技术文档的 canonical source；vault 是生产部署目标和长期记忆真源。`scripts/publish.mjs` 只把 `publish-whitelist.json` 声明的文件发布到 vault，manifest 保存在 vault 的 `00-系统/.index-cache/` 运行态目录。vault 侧热修会被识别为 vault-ahead 或 conflict，发布器不会静默覆盖。

CLI 层使用 Node.js 内置模块并保持零 npm 依赖。记忆 Markdown、frontmatter 和 Obsidian 负责可读数据层；JSON 索引是可重建投影。daemon 层依赖 macOS 的 launchd、plutil、fswatch 和 Swift，CLI 的主要读写逻辑不依赖 launchd。

## 主要技术决策

- Node.js 而非 Python/Bash：与现有脚本生态一致，启动快，内置文件系统能力足够，避免额外运行时和脆弱的 shell 解析。
- 零依赖 frontmatter 处理：当前规模下正则与内置遍历满足性能目标；不保留未安装的 `gray-matter` 声明。
- mtime + JSON cache：小型 vault 的缓存可检查、可重建；无需数据库。
- 人类可读 Markdown 是事实层；热索引、intent map 和语义索引都不能反向覆盖它。
- Frontmatter 使用扁平字段，数组采用 YAML 多行形式；`type`、`created`、`scope`、`projects` 是核心字段。
- plist 只从四个版本化模板渲染。所有 ProgramArguments 是数组，路径先规范化再 XML 转义，`plutil -lint` 通过后才以 0600 原子替换。
- 密钥只存在于 owner-owned 0600 env 文件；解析器逐行处理 allowlist 键，禁止 `source`/`eval`，plist 永不携带值。

## 性能与可靠性边界

索引目标是 200 个文件内冷启动低于 2 秒、缓存命中低于 50ms。同步文件 API 在这一规模更简单可控。

Publisher 使用 PID/ESRCH 锁、停服前 fsync 的恢复清单、原子文件替换、manifest 提交点和 tombstone 回滚。恢复清单的精确字节哈希、事务 ID 与 backup realpath 还会写入 vault runtime 的固定授权台账；`--recover` 只接受与台账一致的材料，同时拒绝第三值，不覆盖恢复清单之外的外部改动。台账和恢复校验用于发现误配置、偶发损坏和非恶意工具误用，不认证同 UID 调用者。durability 承诺只覆盖进程异常恢复；未对所有数据路径做 fsync，因此不承诺掉电一致性。

## 信任边界

普通记忆写入必须经过 `brain-write.mjs`。Publisher 为部署代码而绕过这条管道，权限更高；它要求固定入口、固定 whitelist、clean worktree、路径 realpath 校验和首次发布前的独立评审。外部 guard/hook、宿主身份策略和语义索引不属于本仓库。

同 UID 恶意进程整体不在 P1 防护范围，包括替换路径组件、伪造或替换恢复清单与授权台账，以及自行构造 FD capability。授权台账与恢复清单校验只防误配置、偶发损坏和非恶意工具误用；FD capability 与 test 注入通道的校验也只防误配置，不构成调用者认证或 child 执行范围 containment。生产调用形态由外部 guard 在 2b gate 中限制。

生产 publisher 保留 `BRAIN_VAULT_ROOT` 的最高优先级；未设置时从当前用户的 `~/.config/second-brain/brainkit.conf`（owner 为当前用户、0600、非 symlink）读取 `vault=` 指针。`BRAIN_PUBLISH_CONF` 提供 hermetic 测试的路径覆盖；这些同 UID 可写入口是与 `clip.env` 相同性质的已接受边界。
