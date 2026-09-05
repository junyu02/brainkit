# Second Brain CLI 使用指南

先设置测试或生产 vault，再从 brainkit repo 调用脚本：

```bash
export BRAIN_VAULT_ROOT=/absolute/path/to/vault
```

| 命令 | 作用 |
|---|---|
| `node scripts/cli/brain-write.mjs ...` | 写记忆，执行路由、查重、索引和台账 |
| `node scripts/cli/brain-write.mjs --verify` | 检查索引健康 |
| `node scripts/cli/brain-write.mjs --dry-run ...` | 预览写入 |
| `node scripts/cli/brain-write.mjs --show-route ...` | 查看路由决策 |
| `node scripts/cli/brain-index-summary.mjs` | 输出索引健康报告 |
| `node scripts/cli/brain-query.mjs --query "..."` | 查询记忆 |
| `node scripts/cli/brain-archive-aged.mjs` | dry-run 陈旧条目归档候选 |

## 写一条经验

```bash
node scripts/cli/brain-write.mjs \
  --source manual \
  --type experience \
  --subfolder example-topic \
  --title "示例经验" \
  --description "一行摘要" \
  --body "规则、原因与适用场景。"
```

写入后检查 JSON receipt；需要确认路由时先用 `--show-route`。精确重复默认拒绝，只有确认需要独立条目时才用 `--force-new`。

## 常见诊断

```bash
node scripts/cli/brain-write.mjs --verify
node scripts/cli/brain-index-summary.mjs --scan-missing
node scripts/cli/brain-query.mjs --keywords "keyword-a,keyword-b" --json
node scripts/cli/brain-archive-aged.mjs --threshold 180
```

归档默认 dry-run；只有人工检查候选后才加 `--apply`。不要手动删除记忆或直接编辑索引修复症状，应先确认源文件、台账和路由状态。

## 配置覆盖

| 变量 | 作用 |
|---|---|
| `BRAIN_VAULT_ROOT` | vault 根目录 |
| `BRAIN_MEMORY_DIR` | 宿主热索引目录 |
| `BRAIN_ROUTING_JSON` | routing config |
| `BRAIN_OBSERVE_ENV_PATH` | observe 私有 env 文件 |
| `BRAIN_CLIP_ENV_PATH` | clip 私有 env 文件 |
| `BRAIN_WATCH_ROOT` | fswatch 监听根目录 |
| `BRAIN_FSWATCH_PATH` | fswatch 可执行文件 |

env 文件必须 owner 匹配、0600、非 symlink。模板只列键名，不保存值。
