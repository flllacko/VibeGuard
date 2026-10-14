# VibeGuard 主动验收与 MCP 原型

更新：2026-09-30。当前提供可运行源码和本地 stdio MCP 服务；未发布全局安装包或各宿主的一键配置助手。默认主动验收，自动模式尚未实现。

已新增只展示配置的 `setup codex|claude-code` 以及同包提供的主动验收前采集 Hook；表单添加和采集配置见 [用户接入说明](09-user-mcp-setup.md)。Hook 读取宿主的当前会话身份、保存原文并把 taskRef 补入工具输入；MCP 仍保持三个工具与原参数。宿主 Hook 尚未安装，Claude 尚未应用内实测，不能将本地集成测试写成全平台接入完成。

## 当前实际能力

同一个 VerificationService 供 CLI 和 MCP 调用。MCP 只有三个工具：

| 工具 | 用户能获得什么 |
| --- | --- |
| `verify_task` | 为已登记 taskRef 创建运行；已启用会话采集 Hook 或绑定单条 Codex 会话时可省略 taskRef。相同 taskRef 复用记录，`forceRerun` 明确创建新运行 |
| `get_verification` | 查询状态；完成后返回每项原话、结论、证据编号和限制 |
| `read_evidence` | 读取属于该运行的原始证据片段；注明是否截断 |

工具参数不能指定任意文件、服务地址或 verdict。模型选择由 MCP 服务启动配置决定，默认 DeepSeek Flash，密钥从该服务进程的环境变量读取。

**未绑定执行计划的外部任务只整理要求，尚不能启动任意外部项目代码。**完整材料整理后仍输出 `UNVERIFIABLE`；材料不完整时直接说明缺口，不消耗模型调用。绑定只读文件计划可独立检查授权目录并保存清单、哈希证据，操作见 [文件验收说明](10-readonly-file-verification.md)。受控优惠券样例可以绑定已冻结计划，独立启动内置应用并保存 HTTP 证据。冻结计划可以来自模型或人工，两种来源都在报告中保留。

MCP 协议本身不会自动提供宿主历史对话。现有 Codex 采集器可在服务启动时绑定单条会话，自动通过官方接口读取原文；详见 [真实会话读取试点](08-codex-history-pilot.md)。其他情况下原始材料由用户导出或宿主采集器登记，不能要求干活 Agent 用摘要冒充完整对话。`complete` 仍只是来源声明，原型不能独立证明宿主没有漏发材料。

## 开发者现在怎样试用

在仓库中先执行 `pnpm build`。现阶段先下载源码构建；以后普通用户通过软件包安装和配置向导连接平台。

登记原始任务 JSON：

```powershell
node dist/cli.js register-task --task fixtures/conversations/coupon-complete.json
```

复制输出中的 `taskRef`。普通登记只整理要求，执行结果为无法验证：

```powershell
node dist/cli.js verify-task <taskRef>
node dist/cli.js verification <runId>
```

`verify-task` 默认 DeepSeek Flash，前台等待；只有想换提供商或模型时才加 `--provider`、`--model`。模型密钥配置见 README。退出码 0 已验证、1 失败、2 无法验证、3 参数或内部错误。

长任务可以登记 `--scope checkpoint` 或默认的 `final`。**当前 scope 只记录报告用途，不会自动删除未到阶段的要求**；自动识别阶段范围尚未实现。每次更新材料重新登记，旧 taskRef 和报告保留原快照。文件执行模式会重新读取授权文件状态，变化后不复用旧结论；其他模式不因此获得完整工作树变更检测。

受控样例的实际执行需要之前已生成并保存的计划：

```powershell
node dist/cli.js register-task --task fixtures/conversations/coupon-complete.json --demo-plan <计划摘要> --demo-variant faulty
node dist/cli.js verify-task <新的taskRef>
```

计划必须来自当前演示对话并绑定当前 API 描述。`correct`、`faulty`、`unavailable` 是内置受控目标，不是任意仓库参数。没有已冻结计划时，先按 README 的 M2/M3 步骤生成；登记过程会拒绝不匹配的计划。

## 在支持本地 MCP 的 Agent 中配置

服务的启动命令与参数如下，配置前先完成构建：

```text
command: node
args: D:/CodexWork/VibeGuard/dist/mcp-entry.js --data-dir D:/CodexWork/VibeGuard/.vibeguard
```

许多宿主接受下面这种 JSON 配置，但 **MCP 协议不规定宿主配置文件的格式和位置**。按所用平台的 MCP 设置填写相同的 command/args；不要用这个示例覆盖已有配置：

```json
{
  "mcpServers": {
    "vibeguard": {
      "command": "node",
      "args": [
        "D:/CodexWork/VibeGuard/dist/mcp-entry.js",
        "--data-dir",
        "D:/CodexWork/VibeGuard/.vibeguard"
      ]
    }
  }
}
```

替换成实际安装路径。若宿主找不到 Node，用 `Get-Command node` 得到可执行文件绝对路径。服务进程需要能读取 `DEEPSEEK_API_KEY`；宿主可能过滤环境变量，普通终端里可读不代表 MCP 子进程也可读。未取得密钥时将保留缺口，不打印密钥。用户已自行接入 Codex MCP，原聊天的工具已实际调用；历史采集尚未通过宿主 Hook 自动接通。更新并构建源码后，需要重载已运行的 MCP 服务。

未来已取得原始材料并完成接入时，用户可说：

> 用 VibeGuard 验收已经登记的 taskRef，查询完成结果，并按“用户原话、结论、证据”展示。不要把尚无执行证据的要求说成通过。

`@VibeGuard` 是否可用由宿主界面决定，并非 MCP 的标准入口。

## 运行状态与范围

- `running`：当前服务正在执行，尚无最终 verdict。
- `completed`：运行结束，结论可能是 `VERIFIED`、`FAILED` 或 `UNVERIFIABLE`。
- `indeterminate`：本进程无法确认另一个未完成记录是否仍在执行或已经中断；不能按完成处理。可稍后查询，或明确 `forceRerun` 复验。

启动与完成记录分开保存，避免 Windows 同文件读写争用。查询受控报告时重新检查证据哈希，读取证据必须属于该运行；仍不能抵御同权限进程同时重写程序、证据与清单。服务停止不会自动恢复未完成工作，自动模式、预算取消和完整交付快照绑定尚待实现。

## 本次实际验证

- 官方 SDK 2.2.0 的 stdio 客户端连接、列出工具、调用并查询成功；未配置真实 Agent 平台。
- 集成测试验证材料不完整、拒绝任意路径和 verdict、去重和强制复验、真实失败证据、服务重启读回、证据被改后拒绝查询。
- 使用此前真实 DeepSeek Flash 生成的计划 `eba68a2d5b240beb9527d477361256cdece43020e5f65ae545ec206058bc9ac5` 通过新 MCP 服务执行缺陷版。运行 `2cbae30a-3dfa-8b7c-a38d-cfc9cb84860f` 判 `FAILED`：149.99 元实际优惠 20 元，预期 0；同券重复使用项有执行证据而通过。原始报告 `d3ff338e-760c-4dc5-8a15-1886b7ccdccd` 可由新 CLI 进程读回。

这些记录证明统一入口可复用现有受控 Core，不能证明任意外部项目或所有 Agent 已接入。
