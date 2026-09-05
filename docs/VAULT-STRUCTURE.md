---
type: system
created: 2026-04-13
scope: global
projects: []
source: vault-refactor
tags:
  - system
  - structure
  - reference
---

# VAULT-STRUCTURE — 顶层说明书

> 替代 CLAUDE.md 单点承载全部规则。目录职责、命名、脚本入口、同步/归档策略一次说清。

## 目录职责

| 目录 | 职责 | 允许内容 | 禁止内容 |
|------|------|----------|----------|
| `00-系统/` | vault 控制面 | 策略、映射、迁移产物、scripts、日志 link | 项目/经验/知识内容 |
| `01-项目/` | 项目专属记忆 | 各项目子目录 + 内部文档 | 跨项目通用经验 |
| `02-知识/` | 概念 / 参考 / 方法论 | 稳定的知识性内容、手册、指南 | 一次性踩坑记录 |
| `03-经验/` | 可复用的行为教训 | 踩坑 + 解法、feedback、经验 | 临时日志、运行时状态 |
| `04-对话/` | 精选会话摘要 | 含关键决策/背景的会话精华 | 完整会话原文（自动归档走 `~/.claude/session-data/`） |
| `05-persona/` | 用户画像系统 | primary.md（主）+ 侧写 + 历史画像 | 项目偏好、工具配置 |
| `06-归档/` | 不再活跃的历史文件 | 归档项目、旧策略文档 | 仍在引用的活跃文件 |

## 命名双轨制

放弃"所有文件必须纯中文"的硬约束，分两套：

### 人类可读名（默认，面向人）
- 用中文短语，一眼看懂主题
- 例：`Python多版本缓存导致守护进程加载旧代码.md`、`macOS剪贴板图片读取.md`
- 适用：知识、经验、对话、persona 的主体文件

### 机器路由名（slug 型，面向脚本）
- 允许英文/数字 slug，用下划线或连字符
- 例：`_index.md`、`.project-map.json`、`migration-manifest.json`
- 适用：
  - 系统控制文件（下划线或点开头）
  - 脚本 / 配置 / 迁移产物（`00-系统/` 下所有非人工笔记）
  - 历史迁移产物（`feedback_*.md`、`project_*.md` 在 `~/.claude/projects/*/memory/` 下留存兼容）

### 两类冲突时
- 用户能看懂就用人类可读名
- 纯机器消费、面向脚本/hook 的用 slug 名
- 历史文件**不强制重命名**，新增文件遵守上述规则即可

## Scripts 入口

`00-系统/scripts/` 按子目录分类：
- `cli/` — 人工调用的 CLI（brain-init、brain-clip、brain-archive）
- `daemon/` — 后台守护进程（brain-watch、mempalace-watcher）
- `migrate/` — 一次性迁移脚本
- `lib/` — 共享工具模块（clip-utils 等）

统一入口：`npm run <cmd>`（见 `scripts/package.json`）。

## 同步策略

| 来源 | 目标 | 触发方式 |
|------|------|----------|
| vault 写入 | `~/.claude/projects/*/memory/MEMORY.md` 索引 | SessionStart hook (`brain-watch-handler`) |
| 会话 | `04-对话/` | 人工精选摘要，不自动归档全量 |
| 剪贴板 | `02-知识/` or `03-经验/` | `brain-clip.mjs review` 人工审阅后写入 |
| MemPalace | ChromaDB | `mempalace-sync.sh` 定时同步 |

## 归档策略

| 资产 | 保留策略 |
|------|----------|
| `.trash/` | 删除候选，每季度清理一次 |
| `raw/` | 原始输入快照，半年清理 |
| `.planning/` | GSD phase 执行记录，随项目生命周期保留 |
| `.claude/worktrees/` | GSD 历史 worktree，完成 phase 后删除 |
| `.omc/` | OMC 运行时产物，artifacts 每月清理 |
| `00-系统/migration-*` | 迁移历史快照，永久保留 |

## 生命周期标识

每个项目 `_index.md` frontmatter 必须含：
```yaml
lifecycle: active  # active / paused / archived
```

`01-项目/_index.md` 按 lifecycle 分组展示。

## 画像系统

- `05-persona/primary.md` — AI 默认读取的主画像（**单一真相源**）
- 其余 `.md` — 侧写（不同维度的补充）或历史版本
- 冲突时以 primary.md 为准
