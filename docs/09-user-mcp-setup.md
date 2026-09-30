# 用户自己接入 MCP 与对话采集

更新：2026-09-30。适用于当前源码原型。本文区分已实现的程序、已运行的测试和仍需用户在平台中完成的接入。

## 两项能力，一个 VibeGuard 包

MCP 让 Agent 调用 VibeGuard；采集器让 VibeGuard 取得当前会话原文。它们放在同一个源码包里，共用证据存储和 Core，不需要额外部署网站。

用户在平台的“添加 MCP”页面填写启动程序，这只是添加入口。界面可以是表单或 JSON 编辑器；底层可能保存成 TOML 或 JSON。**MCP 协议不规定设置界面、配置文件格式，也不保证自动提供聊天历史。**

当前要配置两处：MCP 服务和采集 Hook。后续可由配置助手或平台插件包装成一次安装；不能承诺单独添加 MCP 就替用户安装 Hook。

## 先准备源码

安装 Node.js 24 和 pnpm，下载仓库，在 VibeGuard 目录执行：

```powershell
pnpm install
pnpm build
```

尚未发布全局安装包，不使用 `npx vibeguard` 或 `npm install -g vibeguard` 作为当前说明。

已有 `DEEPSEEK_API_KEY` 用户环境变量时，重启 Agent 平台，让平台进程取得新环境；平台过滤变量时还需按下面的方式传递。默认模型是 DeepSeek Flash。密钥不发到聊天，也不由配置生成器打印。

## Codex：按界面填写 MCP

设置 → 插件 → MCP → 添加 → 自定义 MCP。你当前截图里的入口支持表单，不要求手改 TOML。官方说明也提供设置界面、命令行和配置文件三种入口：[MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)。不同客户端版本的菜单名称可能不同。

先生成适合当前电脑的填写说明：

```powershell
node dist/cli.js setup codex
```

这个命令**只展示配置，不修改任何平台配置**。终端找不到 `codex` 时：

```powershell
node dist/cli.js setup codex --codex-bin "Codex可执行文件的完整路径"
```

按输出填写名称、类型、命令和参数；参数每行一项。以当前开发电脑为例：

| 界面字段 | 填写内容 |
| --- | --- |
| 名称 | `vibeguard` |
| 类型 | `STDIO` |
| 启动命令 | `D:\workfile\agent\node\node.exe` |
| 参数第 1 项 | `D:\CodexWork\VibeGuard\dist\mcp-entry.js` |
| 参数第 2 项 | `--data-dir` |
| 参数第 3 项 | `D:\CodexWork\VibeGuard\.vibeguard` |
| 环境变量传递 | `DEEPSEEK_API_KEY`，这里填名称，不填密钥 |
| 工作目录 | `D:\CodexWork\VibeGuard` |

保存并按平台提示重启服务。在 MCP 工具列表确认 `verify_task`、`get_verification`、`read_evidence`。这一步只证明工具连接成功。

### 再配置 Codex 对话采集 Hook

把 `setup codex` 输出的 `hooks` JSON 合并到 `~/.codex/hooks.json`（本机是 `C:\Users\123\.codex\hooks.json`）。已有其他 Hook 时保留它们；可以用编辑器，不必手写全部配置。

该 Hook 只匹配 `mcp__vibeguard__verify_task` 的 `PreToolUse`，即“准备调用验收工具”。用户在新聊天中不再重填会话编号。由平台提供 `session_id`，采集器通过只读 App Server 接口读取原文，不使用“最新日志”猜测当前聊天。

**Codex 要求用户审查并信任非受管 Hook 后才运行。** 保存后按平台的 Hook 管理提示审查、信任并重载；配置文件存在不等于钩子已启用。官方依据：[Hook 位置、信任与输入改写](https://learn.chatgpt.com/docs/hooks)。

Codex 的输入改写必须返回 `permissionDecision: allow`。因此这个 Hook 成功取得原文后会允许**该次 `verify_task` 调用**；它不更改全局审批、其他工具或沙箱设置。若不接受这种行为，可以不安装该 Hook，使用已登记 taskRef 或固定会话试点入口。工具执行或读取失败返回有效的 `deny` JSON；如果平台根本没有触发 Hook，未绑定会话的空参数 MCP 调用会报缺少材料，不能静默猜测。

MCP 与 Hook 必须使用**同一个绝对 data-dir**，并将 MCP 服务命名为 `vibeguard`，否则无法找到采集结果或匹配钩子。配置生成器会输出一致的路径与名称。

## Claude Code：同一包，另一种读取方式

```powershell
node dist/cli.js setup claude-code
```

把输出的 MCP JSON 合并到要验收项目的 `.mcp.json`，把采集 Hook 合并到 `~/.claude/settings.json`。MCP 环境变量配置使用 `${DEEPSEEK_API_KEY}` 引用已有变量，不写真实密钥；这是 Claude Code 支持的语法，不能照搬到每个平台。按 `/mcp` 确认服务并按平台要求批准项目服务；重载后调用。官方说明：[Claude MCP](https://code.claude.com/docs/en/mcp)、[Claude Hooks](https://code.claude.com/docs/en/hooks)。

Hook 同样在调用验收前读取平台的当前会话编号与工作目录。VibeGuard 使用官方 SDK 的 `getSessionMessages` 读取该项目的本地消息链，不启动 Claude 进行任务，也不调用 Anthropic 模型 API。SDK 处理会话分支，VibeGuard 不自行猜测转录文件路径。工具结果不会被当作用户要求。

Claude 的 Hook 只改写 taskRef，不返回 `allow`，工具审批仍由平台处理。远程、未保存、无读取权限或 SDK 未返回记录时停止本次调用。

**当前 Claude 实测是官方 SDK 内存转录测试＋独立 MCP 集成测试，不是 Claude 应用内端到端测试。** 尚不能把“接入代码存在”写成“真实 Claude 已支持”。

## 实际调用链

```text
用户：增加登录功能。
Agent：实现并交付。
用户：用 VibeGuard 验收。
Agent：申请调用 verify_task，不填写或改写整段历史。
平台 PreToolUse Hook：提供当前会话身份。
VibeGuard 采集器：独立读取原文，保存快照，登记 taskRef。
Hook：将 taskRef 补入此次工具参数。
VibeGuard MCP：处理该快照，返回运行编号。
Agent：查询 get_verification，在原聊天展示报告。
```

这是主动验收前的**自动采集**，不是每次 Agent 收尾都自动验收。当前不安装 Stop Hook，不在后台轮询，也不自动修复代码。已经明确指定 taskRef 时保留该登记快照，不另外读取当前聊天。

对话记录保存在 `.vibeguard/host-snapshots/<平台>/<采集ID>/`：原始读取结果、规范化原文、含哈希的采集收据。Hook 只返回 taskRef，原始聊天不重复进入宿主模型上下文。哈希用于发现记录变化，不声称能抵御同权限 Agent 同时篡改记录与哈希。

## 怎么确认自己接好了

1. **工具检查**：能看到三个工具。
2. **采集检查**：在一条明确的测试聊天中主动验收，收据的 threadId/sessionId 与该聊天一致；保存原文包含测试需求及后来的改口。换另一条聊天再验收，不能复用前一条聊天。
3. **报告检查**：调用 `get_verification`；没有执行证据的要求不能显示“已验证”。

当前任务范围未确认时，材料仍标 `partial`，结果为 `UNVERIFIABLE`；这不表示没读到聊天。当前还没有外部项目运行能力，即使材料完整也不能宣布任意登录功能已经验证。下一阶段需要确认业务任务范围并绑定交付与项目运行配置。

## 当前验证记录和支持边界

| 项目 | 实际状态 |
| --- | --- |
| Codex 原文读取 | 本机真实会话通过官方只读接口取得历史 |
| Codex Hook 程序 → MCP | 手工构造当前会话的 PreToolUse 输入，执行实际生成命令，读取真实原文并调用实际 MCP；宿主自动触发尚未启用 |
| Claude 原文读取入口 | 官方 SDK 合成内存转录、角色区分、登记和 MCP 测试通过；尚未在 Claude 应用内实测 |
| Windows 命令与路径空格 | 实际执行生成的 Hook 命令测试通过 |
| Cursor、Qoder、TRAE、WorkBuddy、豆包、ZCode | 可继续调查或使用通用 MCP；未完成这些平台的完整对话采集接入，不套用 Codex/Claude Hook 配置 |

2026-09-30 本次本地链路检查读取 42 条用户消息、146 条助手消息，读完历史页，包含最初交接说明和本次 MCP 界面讨论。采集 `aa296b1c-2dd9-4d83-91f1-930fc96d30c5`，任务 `98008b31-3922-4243-bf30-8d0a8bbb05ea`，运行 `d1f36454-3d31-82dc-a753-3abd2045938b` 因任务范围待确认返回 `UNVERIFIABLE`，无模型调用。记录在 `.vibeguard/integration-checks/codex-hook-20260930.json`。没有修改用户全局 MCP、Hook 或权限配置，也没有通过 UI 绕过 Hook 信任。
