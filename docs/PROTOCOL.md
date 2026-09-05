---
name: Vault Memory Protocol
description: 宿主中立的 Second Brain vault 读写协议
type: reference
audience: [agents, maintainers]
---

# Vault Memory Protocol

本协议定义任何 AI 助手或自动化如何读取及建议写入 Second Brain vault。vault 根目录由 `BRAIN_VAULT_ROOT` 指定。

## 1. 读取

全部文件可读。优先从宿主维护的轻量索引开始，再按 type 路由到 vault 分区，最后用标题词与领域词宽泛检索。索引和语义数据库都是可重建投影，vault 文件才是真源。

## 2. 写入

具备本机执行权限的宿主一律调用：

```bash
node "$BRAIN_VAULT_ROOT/00-系统/scripts/cli/brain-write.mjs" \
  --source <host-id> \
  --type <type> \
  --title <title> \
  --description <description>
```

正文从 stdin 或 `--body` 传入。管道负责 section policy、查重、索引更新与台账。编辑器、重定向或自定义脚本直接写记忆 Markdown 都属于绕过管道。

目录级 sandbox 不能阻止授权目录内的裸写，因此完整性同时依赖调用约定、写入台账和外部控制面的审计。外部 guard 不包含在本仓库中。

只读宿主，或遇到路由不清、敏感内容、需要合并既有记忆时，使用提议通道：

```xml
<memory-propose type="feedback|project|reference|user-profile|experience" title="人类可读标题" projects="可选项目名">
一句规则或事实。
Why: 原因。
How to apply: 适用场景。
</memory-propose>
```

维护者查重并逐条决定写入、跳过或编辑。普通任务输出、可从代码推导的信息、临时状态和未验证推测不应沉淀。

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
- 不删除记忆；修订或归档交维护者裁决。
- 凭证、密码和密钥不得进入 vault、日志、模板或 git 历史。
- `00-系统/` 的代码发布由 `scripts/publish.mjs` 管理，不属于记忆写入。
- Publisher 是高权限例外路径，首次真实发布前必须完成独立只读安全复核。
