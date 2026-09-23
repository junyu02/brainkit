---
name: Brainkit local HTTP MCP
description: 带 bearer token 的本机 Streamable HTTP MCP 运行边界
type: reference
audience: [maintainers]
---

# 本机 HTTP MCP

`scripts/daemon/brain-http.mjs` 是一个无 SSE、无 session 的本机 JSON-RPC POST 端点。它只监听
`127.0.0.1` 或 `::1`，默认只接受同一 loopback Host/Origin。它实现 MCP Streamable HTTP 的 POST JSON
响应形式；GET 明确返回 `405`，因此不提供 SSE、断线续传或服务端推送。

它可以直接在这台电脑上常驻并供本机客户端使用，不需要另一台主机。SSH 转发和反向代理只是需要跨设备
访问时的可选路径，不会自动安装、启动或创建任何远程资源。

认证文件由操作者自行创建，必须是当前用户拥有的普通单链接文件，权限为 `0600`。文件只保存 token 的
SHA-256 摘要，不能保存明文 token；目录检查只看认证文件的直接父目录，不像 checkpoint 状态目录那样逐级
检查到根，因此要把认证文件放在整条路径都由当前用户拥有、他人不可写的目录下：

```json
{
  "tokens": {
    "replace-with-64-lowercase-sha256-hex": {
      "actor": "remote-reader",
      "scopes": ["read"],
      "expires": "2026-12-31T00:00:00Z"
    }
  }
}
```

`actor` 由认证文件固定；请求中的 `clientInfo` 不会覆盖它。`read` token 不会在 `tools/list` 中看到写操作，
也无法调用写操作，但 `read` scope 仍能调用 `synthesize`——它会向已配置的模型端点外发笔记内容并产生费用，
不希望远端触发模型调用就不要发放该 token。需要写权限时，单独创建带 `["read", "write"]` 的短期 token；写入仍通过
`brain-write.mjs`，不是 HTTP 服务直接写 Markdown。远程写请求还必须带 UUID `request_id`；超时或连接
断开只能表示结果未知，不能当作未写入。使用同一个 `request_id` 查询或重试，直到拿到 writer 回执。

在已准备好的 scratch vault 中运行：

```bash
chmod 600 /secure/path/brain-http-auth.json
node scripts/daemon/brain-http.mjs --auth-config /secure/path/brain-http-auth.json --host 127.0.0.1 --port 3333
```

客户端向 `http://127.0.0.1:3333/` 发送 `Content-Type: application/json`、`Authorization: Bearer …` 的
JSON-RPC POST。服务不会生成、输出或记录 token 和请求正文。子进程若先于 payload 写完就退出（例如
`capabilities`、`doctor` 不读 stdin，这两个操作也会忽略传入的 arguments），子进程 stdin 上的 EPIPE
会被吞掉，不会让 daemon 崩溃。单个请求最大 1 MiB；默认同时处理 8 个请求、
每个 token 同时 2 个、每分钟 60 个，单个请求从正文读取到操作完成最多 15 秒，这是软超时：超时后 HTTP
响应即返回，写操作在后台继续执行，并发槽位要等子进程真正退出才释放。超时的读取操作会终止
子进程；已启动的写入继续由 writer 完成，HTTP 只返回结果未知，随后应以同一 `request_id` 重试。
为避免异常写入永久占用并发槽，子进程还有 120 秒执行硬上限；到期会终止该请求自己的进程组，5 秒后仍未
退出才强制结束，因此单个写请求占用槽位的上界是 120 秒加 5 秒。它不会在 15 秒响应时终止已启动写入。

若经 SSH 转发或反向代理访问，进程仍必须监听 loopback。反向代理必须自行完成 TLS，并在认证文件中显式
设置它将转发的 Host 与 Origin：

```json
{
  "allowed_hosts": ["memory.example.test"],
  "allowed_origins": ["https://memory.example.test"],
  "tokens": { "...sha256...": { "actor": "proxy-reader", "scopes": ["read"], "expires": "2026-12-31T00:00:00Z" } }
}
```

没有由可信反向代理完成的 TLS 终止时，不要把该端口直接暴露到互联网。SSH 转发通常不需要放宽
`allowed_hosts` 或 `allowed_origins`，因为服务仍看到 loopback 请求。
