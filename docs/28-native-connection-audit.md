# 原生连接版本与真实对话采集核对

日期：2026-10-21。这里只验证连接与材料，不是一次任务功能验收。

## 为什么加这一步

构建更新了磁盘上的代码，平台已连接的 MCP 进程或工具参数缓存却可能还停在旧版。只看到三个工具名称不能证明它支持外部项目验收。

`doctor` 现分别检查：配置、本包新进程连接、外部参数与版本资源。平台实际加载版本始终单列为待检查，不能拿独立客户端的结果代替。检查不调用模型，不运行项目，也不向子进程传递模型密钥。

保留原三个工具；新增只读 MCP 资源 `vibeguard://connection`：

```json
{"schemaVersion":1,"protocolRevision":"2026-10-21.external-http.v1","verifyParameters":["externalPlanRef","captureTicket"],"diagnosticOnly":true}
```

它仅提供兼容性标记，不读取聊天或项目，不触发验收。标记不是签名证明，也不能证明采集 Hook 已被宿主信任或执行。自检同时核对真实 `tools/list` 中这两个参数的 UUID 类型，不能单凭版本字符串判兼容。

## 本轮真实观察

| 检查 | 实际结果 |
| --- | --- |
| 现有用户配置 | 与当前向导一致；未修改全局配置 |
| 新启动本包 MCP | 新参数及版本资源可读 |
| 当前 Codex 暴露的工具参数 | 缺少 `externalPlanRef`、`captureTicket`，尚不能进行新入口调用 |
| 当前原生连接读历史记录 | 读回 `70142b91-e9e7-40ea-92b6-7e3630a90fc5` 成功；保留其历史 `UNVERIFIABLE` 结论 |
| 当前原生连接资源列表 | 返回 `-32601 Method not found`；仅这条错误本身不足以判定程序版本 |
| 当前真实聊天采集 | 显式 CLI 启动只读 Codex App Server，读完 4 页，77 条用户、318 条助手消息 |
| 会话身份与截止点 | 当前会话 `01a0ddc2-7eca-7200-918b-7d916f928cc6`；最后用户原文为本轮“下一步” |
| 文件读回 | 原始响应及会话副本的 SHA-256 与收据一致 |
| 材料缺口 | 2 项非文字内容未解析；未确认本次任务范围 |

首次受限进程采集返回 `thread not loaded`；相同命令在授权普通权限下成功。没有因此把宿主历史故障改成空历史、恢复对话或发送新消息。

采集编号 `4d664ae2-61fc-4184-998e-2acbe5338dc2`，任务编号 `5481433c-3655-40ce-9d46-472e44015d46`。截止用户消息 `01a15d7a-2e25-76c1-8edf-d7e34f001a54`。当前观察不能区分旧进程与平台参数缓存；都需要重载后再核对。

本轮 **0 次模型调用、0 次项目执行、0 项全局配置修改**。构建成功，164 项程序测试通过，包括旧工具同名但缺参数的拒绝、版本不匹配、真实 stdio 资源读取且数据目录不产生记录，以及绑定采集器不被版本检查调用。测试不是用户任务验收通过。

本地记录在 `.vibeguard/evaluations/native-connection-20261021/`（Git 忽略）：`native-tool-declarations.json`、`native-readback.json`、`doctor.json`、`summary.json`、采集 `data/` 和只读复核脚本 `audit.mjs`。这些材料包含聊天原文，勿公开提交。

## 自己检查与下一步

```powershell
node dist/cli.js doctor codex --format json
node --test dist/tests/connection-protocol.test.js dist/tests/connection-wizard.test.js
```

1. 重新加载平台中的 VibeGuard MCP；没有对应入口时，完全退出并重新打开 Codex。
2. 从原生连接核对工具参数；平台支持资源读取时再读 `vibeguard://connection`，与上面的标记比对。无需调用 `verify_task`、上传聊天或执行项目来检查版本。
3. 版本核对后再实测原生 Hook 自动采集及真实任务要求确认。若不能获取资源，保留这一项未知，并继续核对工具参数及真实行为，不直接宣布支持或不支持。

**未执行：**新版接口在当前原生连接中的调用、原生 Hook 本轮自动触发、跨聊天复测、项目功能验收。显式采集成功不能替代这些证据；不主动结束正在运行的 Codex 来制造重载结果。
