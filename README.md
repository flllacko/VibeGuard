# VibeGuard 开发原型

VibeGuard 验收 AI Agent 的交付：保留用户原话，独立取得实际证据，分别报告已验证、验证失败、无法验证。当前已完成 **M1 受控样例证据闭环**；**M2 对话整理**和 **M3 需求驱动规划**已部分实现，新增 **M5 主动验收与 MCP 原型**。DeepSeek Flash 已在公开样例及两份新合成对话中整理要求；新优惠券计划在正确、两种缺陷、不可用实现上产生预期证据，详见 [保留样本开发评估](docs/heldout-evaluation-2026-09-29.md)。尚未实现外部项目隔离、真实宿主完整接入或自动验收。

默认由用户说“用 VibeGuard 验收”后发起检查；自动验收作为后续可开启的模式，默认关闭。MCP 是 Agent 调用 VibeGuard 的工具入口，不会自动提供完整聊天记录，也不保证存在 `@VibeGuard` 入口。

## 用户自己接入：先生成填写说明

Codex 的设置界面可以直接添加 MCP，**不要求手改 TOML**。当前采集器随同一个 VibeGuard 源码包提供；配置 MCP 和采集 Hook 后，Hook 会从宿主取得当前会话身份，在主动验收前独立读取原文、登记任务。用户不用每换聊天都填写编号。MCP 与 Hook 各配置一次，不能声称只加 MCP 就自然获得聊天历史。

```powershell
pnpm build
node dist/cli.js setup codex
# Claude Code 的配置说明
node dist/cli.js setup claude-code
```

`setup` **只显示适合本机的表单字段和配置片段，不修改平台配置**，不打印密钥。Codex 的非受管 Hook 还须用户在平台中审查并信任；其输入改写会允许该次验收工具调用。Claude 入口使用官方 SDK 本地读取，不调用 Anthropic API。完整操作与限制见 [用户接入说明](docs/09-user-mcp-setup.md)。

本次 Codex 检查使用手工构造的 Hook 输入，实际读取本条会话的 42 条用户消息和 146 条助手消息，再进入实际 MCP 服务；尚未启用原聊天的宿主自动 Hook。Claude 通过 SDK 合成转录与 MCP 集成测试，尚未在 Claude 应用内实测。任务范围未确认、外部执行尚未接入，因此不能据此宣称真实业务任务已验收完成。

## 主动验收与 MCP（M5 原型）

CLI 与 MCP 共用同一个验收服务。先构建，再登记原始对话：

```powershell
pnpm build
node dist/cli.js register-task --task fixtures/conversations/coupon-complete.json
node dist/cli.js verify-task <登记输出的taskRef>
node dist/cli.js verification <运行输出的runId>
```

`verify-task` 自动读取环境变量，默认 DeepSeek Flash。**普通外部任务目前只整理要求，仍报告无法验证**；只有绑定冻结计划的内置受控样例能实际执行。MCP 提供 `verify_task`、`get_verification`、`read_evidence` 三个工具，启动文件为 `dist/mcp-entry.js`；支持本地 MCP 的宿主填写启动命令即可连接。

Codex 的早期固定会话试点仍保留：`node dist/cli.js capture-codex <会话编号>`，或 MCP 启动参数 `--codex-thread <编号>`。新接入优先使用上面的采集 Hook，由平台提供当前会话身份，不把一个全局固定编号误用于所有聊天。详见 [Codex 真实会话读取试点](docs/08-codex-history-pilot.md)。

具体启动配置、长任务阶段范围的当前限制和已实测证据见 [主动验收与 MCP 使用说明](docs/07-mcp-prototype.md)。目前需要下载源码构建，尚未发布全局安装包，也未修改任何宿主的全局配置。

## 当前可运行效果

内置样例中，用户先说“订单满 100 元减 20 元”，后改成“满 150 元，其他规则不变”。程序使用手写的门槛验收计划，分别以 150 元和 149 元发起真实 HTTP 结算请求，再查询保存的订单。缺陷版错误地让 149 元订单获得优惠；服务不可用时报告无法验证。每次执行的原始请求、响应、订单查询和报告保存在 `.vibeguard/`，可按 ID 重新读取。

```powershell
pnpm build
pnpm test
node dist/cli.js verify --variant correct
node dist/cli.js verify --variant faulty
node dist/cli.js verify --variant unavailable
node dist/cli.js report <运行ID> --format json
node dist/cli.js evidence <证据ID>
```

`verify` 的退出码：0 表示本轮**门槛检查范围**已验证，1 表示该范围失败，2 表示无法验证，3 表示参数或内部错误。完整优惠券任务还包含“每张券只能使用一次”，当前没有检查，因此正确版本的**整个任务**仍为无法验证。运行记录会显示具体范围。

需要 Node.js 24 与 pnpm。Docker Desktop 已可用，但 M1 只运行本项目自己编写的受控样例，尚未把外部代码放入容器。架构和后续阶段见 [文档索引](docs/00-README.md) 与 [实施状态](docs/implementation-status.md)。

## 导入完整对话与整理要求（M2 开发中）

`intake` 接受一份 JSON 对话文件，保存消息原文、顺序、任务边界、来源和内容摘要。示例格式见 `fixtures/conversations/coupon-complete.json`。`transcriptCoverage.level: complete` 是提交者对**明确任务边界内**材料的声明；它本身不能证明宿主没有漏发消息。程序还会检查首尾 ID、序号缺口和摘要来源。

```powershell
node dist/cli.js intake --task fixtures/conversations/coupon-complete.json
node dist/cli.js resolve --task fixtures/conversations/coupon-complete.json --provider deepseek
node dist/cli.js resolution <要求整理ID> --format json
```

`<要求整理ID>` 替换为 `resolve` 输出的 ID。`--provider deepseek` 默认使用 `deepseek-flash`；想用 Pro 时才加 `--model deepseek-v4-pro`。`resolve` 需要对应 API Key，下面有配置方法。

`resolve` 调用 Pi 的模型 API，让模型提出要求新增、修改、取消事件；程序核对每条用户消息的去向及每段原话是否逐字存在。若缺模型凭据、模型输出错误或材料不完整，保存缺口并退出为“无法完成整理”。DeepSeek Flash 已在内置优惠券对话上真实整理出门槛、单次使用和已取消的过期限制；**一个样例不证明一般场景的理解质量**。消息都有处理记录也不能证明模型绝不会漏掉语义上的要求，正式报告仍要展示清单供人复核。

材料或整理仍有缺口时，终端会先显示原因，再把条目标为“已见材料的候选要求”，不会把它们直接称作最终当前要求。阶段指令的两份合成对照样例在 `fixtures/conversations/phase-start-after-docs.json` 与 `phase-discussion-continues.json`：真实 DeepSeek Flash 调用分别撤销了“先不写代码”和保留了该限制。它们不是宿主长对话准确性的证明。

Pi 依赖采用 `@earendil-works/pi-ai` 0.87.1。pnpm 的两个非必需传递依赖构建脚本已明确禁用；DeepSeek Flash 的真实调用已通过，Kimi 尚未做账户实测。

### Trae Hook 事件收集原型

目前仅能**手工向 CLI 输入 Trae Hook 形状的 JSON**，并把观察到的用户输入和最后一条助手回复导出为候选对话。VibeGuard 还没有替你安装 Trae Hook，也不会自动验收 Trae 项目。下面的 PowerShell 命令只演示字段流转：

```powershell
'{"session_id":"demo-1","hook_event_name":"UserPromptSubmit","prompt":"增加登录功能"}' | node dist/cli.js capture-trae-hook
'{"session_id":"demo-1","hook_event_name":"Stop","last_assistant_message":"已完成"}' | node dist/cli.js capture-trae-hook
node dist/cli.js export-trae-session demo-1
```

收集命令成功时不向 stdout 写内容，避免把日志当成给干活 Agent 的新指令。每个事件单独保存在 `.vibeguard/host-events/`，会话 ID 用哈希作为目录名；导出结果始终标 `partial`。[Trae 官方 Hook 字段说明](https://docs.trae.cn/ide_hook-configuration-reference)分别给出当前 `prompt` 和 `last_assistant_message`，它们本身不能证明之前所有轮次、助手中间输出和任务边界都已收齐。这个候选对话可以检查采集格式，但**不能直接冻结完整任务的验收计划**。不要把真实 API Key、账号密码或其他秘密放进模拟 Hook 输入。

### 模型 API Key 与默认模型

**不要把真实 API Key 发到聊天窗口或提交到 Git。** Windows 上只需设置一次用户环境变量：

1. 在开始菜单搜索并打开 **“编辑账户的环境变量”**。
2. 点击“新建”，变量名填 `DEEPSEEK_API_KEY`（DeepSeek）或 `MOONSHOT_API_KEY`（Kimi 通用 API），变量值填对应平台的 API Key。
3. 关闭并重新打开 PowerShell；如果要让已经打开的 Codex 代为调用，也要重启 Codex。VibeGuard 随后会自动读取，无需在命令中填写密钥。

```powershell
node dist/cli.js providers
node dist/cli.js resolve --task fixtures/conversations/coupon-complete.json --provider deepseek
# Kimi 中国站：把最后的 deepseek 改为 kimi
```

`providers` 只显示变量**是否设置**，不会打印密钥；“已设置”仍不代表账户有调用权限或余额。用户环境变量会长期保存在当前 Windows 账户下，同账户运行的程序可以读取。macOS/Linux 可在当前 shell 使用 `export DEEPSEEK_API_KEY='你的密钥'` 或 `export MOONSHOT_API_KEY='你的密钥'`；直接把真实密钥写进命令可能进入 shell 历史记录。

<details><summary>只想在当前 PowerShell 窗口临时使用</summary>

```powershell
$vgKey = Read-Host "DeepSeek API Key" -AsSecureString
$env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new("", $vgKey).Password
Remove-Variable vgKey
```

关闭此窗口后需要重新设置。Kimi 把变量名改为 `MOONSHOT_API_KEY`。

</details>

当前内置默认映射：`deepseek → deepseek/deepseek-flash`，`kimi → moonshotai-cn/kimi-k3`，`kimi-global → moonshotai/kimi-k3`。前半段是 Pi 实际调用的 provider；每次真实调用仍需以该账户实测。模型目录会变化，VibeGuard 的默认值不会偷偷自动切换；需要换模型时显式加 `--model`。DeepSeek 的 [更新日志](https://api-docs.deepseek.com/updates/) 和 Kimi 的 [API 概览](https://www.kimi.ai/help/kimi-api/api-overview)列出了这两个模型 ID。

豆包、硅基流动、百炼目前**没有** VibeGuard 的同格式入口，不能仅设置密钥就使用 `--provider doubao/siliconflow/bailian`。它们各自还需要确认接口地址、模型 ID、账户地域或权限，并通过真实调用验证；接入后才会加入上面的默认列表。当前 `verify --variant ...` 是受控演示命令，**还不能**执行 `vibeguard verify task.json --provider deepseek` 这样的完整自动验收。M2/M3 的真实模型流程是 `resolve` → `plan` → `run-demo-plan`（仅内置受控样例）；外部项目隔离执行仍在开发。

## 冻结计划并执行（M3 受控演示）

M3 的程序规则要求每条当前有效要求都有检查目标，或明确说明暂时无法检查；已取消的要求不能重新变成必需项。计划包含 HTTP 操作和预期断言，程序固定计划摘要后才执行。`demo-plan` 使用人工固定样例，用于验证执行与覆盖规则：

```powershell
node dist/cli.js demo-plan --variant correct
node dist/cli.js demo-plan --variant faulty
node dist/cli.js demo-plan --variant unavailable
node dist/cli.js planned-report <运行ID>
```

正确版的 150/149 门槛检查通过，但“一次使用”仍未检查，因此整个任务输出 `UNVERIFIABLE`。缺陷版会在 149 元订单的保存记录中发现 20 元错误优惠，输出 `FAILED`。服务不可用时输出 `UNVERIFIABLE`。三次运行使用相同的计划摘要，目标代码摘要随变体变化；报告及逐步 HTTP 证据保存在 `.vibeguard/planned-runs/`，可在新进程读取并核对哈希。`demo-plan` 的退出码按整个任务结论给出：0 已验证、1 失败、2 无法验证、3 参数或内部错误；上面的旧 `verify` 命令仍按门槛检查范围给出退出码。

`plan` 让模型根据**已完成的要求整理**和授权 API 描述生成候选计划。程序拒绝漏项、越界接口、自行提交结论、错误的成功状态码及跨检查复用优惠券。计划摘要还绑定 API 描述摘要；旧描述对应的计划不能继续运行。冻结只说明候选计划通过这些检查，**不等于交付通过验收**。

```powershell
node dist/cli.js plan --resolution <要求整理ID> --profile fixtures/profiles/coupon-api.json --provider deepseek
node dist/cli.js plan-record <计划摘要> --format json
node dist/cli.js run-demo-plan --plan <计划摘要> --variant correct
node dist/cli.js run-demo-plan --plan <计划摘要> --variant faulty
node dist/cli.js run-demo-plan --plan <计划摘要> --variant unavailable
```

`run-demo-plan` 只接受内置优惠券对话和受控演示 API，不会启动任意外部 Agent 代码。一次真实 DeepSeek Flash 计划在正确版得到两条要求均 `VERIFIED`，缺陷版发现低于 150 元 1 分时仍优惠 20 元而判 `FAILED`，服务不可用版判 `UNVERIFIABLE`。同一计划摘要和原话引用贯穿三次运行；保留样本已有首次开发评估，仍需更多独立任务估计漏条件和错误预期的发生频率。

开发评估还提供 `node dist/evaluate-heldout.js --plan <保留样本计划摘要>`：它只接受保留的优惠券任务及中性接口说明，分别运行正确版、旧门槛版、旧优惠金额版和服务不可用版。该脚本是评估工具，不能用于验收任意项目；输入、标准答案和本次实测结果见上方评估文档。

受控演示报告现在把用户原话、每条要求的结论和执行证据 ID 放在一起。本地文件哈希只能发现读取时的文件变化；若干活 Agent 与 VibeGuard 共享证据目录的写权限，不能据此宣称证据无法伪造。
