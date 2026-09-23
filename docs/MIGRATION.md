# Migration Runbook

本 runbook 只描述操作。首次真实发布前，先完成 publisher commit 的独立安全复核以及外部控制面的固定入口/固定目标 allowlist 复核。不要在实现阶段运行 launchctl 或写生产 vault。

以下命令中的路径必须替换为真实绝对路径：

```bash
export BRAINKIT_REPO=/absolute/path/to/brainkit
export BRAIN_VAULT_ROOT=/absolute/path/to/vault
export BRAIN_CLIP_ENV_PATH=/absolute/path/to/private-config/clip.env
export BRAIN_OBSERVE_ENV_PATH=/absolute/path/to/private-config/observe.env
```

## Step 0 — preflight 与 K1

```bash
test -d "$BRAIN_VAULT_ROOT"
test ! -L "$BRAINKIT_REPO"
command -v git
command -v node
command -v plutil
command -v fswatch
command -v swiftc
df -h "$BRAIN_VAULT_ROOT"
mkdir -p ~/.config/second-brain
test ! -L ~/.config/second-brain/brainkit.conf
install -m 600 /dev/null ~/.config/second-brain/brainkit.conf
printf 'vault="%s"\n' "$BRAIN_VAULT_ROOT" > ~/.config/second-brain/brainkit.conf
chmod 600 ~/.config/second-brain/brainkit.conf
```

生产 publisher 从 `~/.config/second-brain/brainkit.conf` 的 `vault=` 行读取 vault；值必须是绝对路径，含空格时使用上例的双引号形式。文件必须属于当前用户、权限为 0600 且不能是 symlink。`BRAIN_PUBLISH_CONF` 只用于 hermetic 测试覆盖指针路径，生产使用默认路径。

如果尚未创建 repo，`test ! -e "$BRAINKIT_REPO"` 必须通过；已完成 step 1 的迁移续跑则检查 `.brainkit-migration-id` 和 realpath，禁止误删其他目录。

逐一记录四个 allowlisted LaunchAgent 的 label、loaded、state 和 plist path。不要保存或打印 `EnvironmentVariables`。对待迁移文件生成 sha256 基线，条目数必须等于当时 whitelist 数。

创建 `clip.env` 时只用编辑器手工写值，不从命令行回显凭证：

```bash
install -m 600 /dev/null "$BRAIN_CLIP_ENV_PATH"
chmod 600 "$BRAIN_CLIP_ENV_PATH"
```

文件要求 `DEEPSEEK_API_KEY=...`，可选 `CLIP_VISION_MODEL`、`CLIP_TEXT_MODEL`、`CLIP_API_BASE`；owner 必须为当前用户，且不能是 symlink。

失败逆操作：step 0 除私有 env 文件外不改生产代码；删除空 env 文件前先确认它由本步骤新建。

## Step 1 — 建 repo、身份标记和基线 commit

```bash
mkdir "$BRAINKIT_REPO"
git -C "$BRAINKIT_REPO" init
```

创建 `.brainkit-migration-id`（时间戳加随机标识），按冻结 disposition 表复制允许文件，排除 runtime、migrate、graveyard、二进制和备份。复制后逐项核对 sha256，再提交：

```bash
git -C "$BRAINKIT_REPO" add -A
git -C "$BRAINKIT_REPO" commit -m "chore: initial snapshot of vault system scripts"
```

失败逆操作：只有 `.brainkit-migration-id` 存在且 repo realpath 与预期完全一致时，才允许移除新建 repo；否则停止并人工检查。

## Step 1b — 初始化 manifest

在任何债务修改前运行：

```bash
cd "$BRAINKIT_REPO"
node scripts/publish.mjs --bootstrap
node scripts/publish.mjs --check
```

若 publisher 晚于 step 1 快照实现而需补跑，此时 R≠V 属预期；bootstrap 会以 vault 当前内容为基线并输出警告，随后 `--check` 将 repo 修改显示为 repo-ahead、vault 缺失目标显示为 repo-new。

按原时序执行时，预期 manifest 只生成在 `00-系统/.index-cache/publish-manifest.json`，所有条目 clean，vault scripts 内容和 mtime 不被 bootstrap 改写。

失败逆操作：确认 manifest 是本次 bootstrap 新建后移除它，再重跑；不要改 scripts 伪造 clean。

## Step 2 — 债务清偿

逐逻辑单元提交 publisher/tests、plist renderer/templates、路径 env 化、K2、examples、docs 和 package metadata。每个 commit 后运行：

```bash
node tests/run-all.mjs
node scripts/publish.mjs --check
```

预期：测试全绿；`--check` 仅出现 repo-ahead、repo-new 或 same-change，退出 1。出现 vault-ahead、conflict 或不可验证态立即停止。

### Step 2a — publisher 独立复核

把 publisher commit hash 交给独立只读 reviewer。记录 PASS/FAIL、findings、测试和精确 commit。FAIL 必须修复后以新 commit 重审，不能自批后发布。

### Step 2b — 外部控制面 gate

在控制面的 canonical source 中登记 publisher 与 sunday integration，并为固定 publisher realpath、固定目标集和固定调用形态建立精确 allowlist。流程必须是 canonical commit → 独立只读 review PASS → 受管 apply。此仓库不包含也不替代外部 guard。

guard allowlist 必须拒绝 publisher 调用中的全部 test 形态：`NODE_ENV=test`；任何 `BRAIN_PUBLISH_TEST_*` 环境变量（包括 `BRAIN_PUBLISH_TEST_HOOK`）；`BRAIN_PUBLISH_MOCK_STATE`；出现 `BRAIN_PUBLISH_LAUNCHCTL` 或 `BRAIN_PUBLISH_LAUNCHAGENT_DIR`；`BRAIN_PUBLISH_BACKUP_ROOT` 使用默认值以外的值；以及向 FD3 或其他额外文件描述符重定向或继承。生产 guard 必须把这些 test 通道整体拒之门外，不能依赖 publisher 内的 FD capability 或路径校验充当同 UID 安全边界。

**已接受边界（ambient 环境变量）**：guard 校验的是 Bash **命令字符串**——上述变量作为命令行前缀（`BRAIN_VAULT_ROOT=/tmp node …`）会被拒绝。guard **不认证** Claude/runner 父进程的 ambient 环境：若 `BRAIN_VAULT_ROOT` 或 `BRAIN_PUBLISH_CONF` 已在父进程 export，plain 命令 `node …/publish.mjs --check` 会继承它们，publisher 的 `resolveRoots()` 会读到被重定向的 root。要 export 父进程环境变量属同 UID 动作，落在「同 UID 恶意进程不在 P1 防护范围」（Oscar 2026-08-21 裁决）之内，因此本 gate 不要求闭合。若未来威胁模型改为防父进程环境污染，闭合应优先在 guard（扫 `os.environ` 的 test 变量、把 repo/vault ambient root 限定为固定 production realpath），不在 publisher 全局禁用（会破坏其已评审 hermetic 测试设计并重开 2a）。

## Step 3 — 首次 publish 与 K4

仅在 2a/2b 双 PASS 后进入冻结窗口：

```bash
cd "$BRAINKIT_REPO"
node scripts/publish.mjs
node scripts/publish.mjs --check
```

人工逐文件审 diff，确认 reviewer commit hash 与发布源一致，然后立即用真实图片验证 clip 链路。不要只检查 daemon loaded。

失败时 publisher 会输出备份目录并自动回滚；若进程中断：

```bash
node scripts/publish.mjs --recover /absolute/path/to/backup-dir
```

`--recover` 可重复运行，但遇到第三值会拒绝覆盖并要求人工裁决。

## Step 4 — 安装 observe/sunday/watch 无密钥 plist

先为每个 daemon 建立日志目录，再从 `templates/` 渲染。示例：
发布进 vault 的 CLI 副本不承载 install；plist 模板只在 brainkit repo 内，必须从 repo 执行 install/plist 渲染。

```bash
node scripts/lib/plist-render.mjs \
  --template "$BRAINKIT_REPO/templates/com.second-brain.observe.plist.template" \
  --output /absolute/path/to/LaunchAgents/com.second-brain.observe.plist \
  --var NODE_PATH=/absolute/path/to/node \
  --var OBSERVE_PATH="$BRAIN_VAULT_ROOT/00-系统/scripts/cli/observe.mjs" \
  --var LOG_PATH=/absolute/path/to/logs/observe.log
```

对 sunday 和 watch 传对应模板的全部变量。`plutil -lint` 必须通过，输出权限必须为 0600。人工 bootout 旧服务、bootstrap 新 plist，再用 `launchctl print` 只解析 label/state/path。

失败逆操作：bootout 新服务，用 step 0 存档参数重新渲染旧版并 bootstrap。

## Step 5 — clip secret-removal cutover

保留旧 clip plist 原位作为短期回滚材料，另行渲染无 key plist：

```bash
node scripts/lib/plist-render.mjs \
  --template "$BRAINKIT_REPO/templates/com.second-brain.clip.plist.template" \
  --output /absolute/path/to/LaunchAgents/brainkit/com.second-brain.clip.plist \
  --var NODE_PATH=/absolute/path/to/node \
  --var CLIP_HANDLER_PATH="$BRAIN_VAULT_ROOT/00-系统/scripts/daemon/brain-clip-handler.mjs" \
  --var LOG_PATH=/absolute/path/to/logs/clip.log
```

切换后再验一张真实图片。失败时 bootout 新 plist，bootstrap 原位旧 plist；不要复制或打印旧 plist 内容。

## Step 6 — 端到端验收与 soak

```bash
node tests/run-all.mjs
node scripts/publish.mjs --check
BRAIN_VAULT_ROOT="$BRAIN_VAULT_ROOT" node scripts/cli/observe.mjs --limit 1
BRAIN_VAULT_ROOT="$BRAIN_VAULT_ROOT" node scripts/cli/brain-harvest.mjs --self-test
BRAIN_VAULT_ROOT="$BRAIN_VAULT_ROOT" node scripts/cli/brain-weekly.mjs --dry-run
```

四个 daemon 连续 soak 至少三天。任何失败按 step 3/4/5 的逆操作恢复，不跳过真实 clip 验活。

## Step 7 — 删除旧 clip plist

soak 期满、clip.env 成为唯一 key 载体且全量扫描无历史泄漏后，才删除旧 plist。此步骤不可逆，应记录日期、最终测试和 reviewer 证据。

P1 到此仍不做公开发布。P3 已补齐 LICENSE、面向公众的 README 与全 git 历史终扫；真正的 public push 仍需维护者单独确认。
