# VibeGuard 开发原型

VibeGuard 验收 AI Agent 的交付：保留用户原话，独立取得实际证据，分别报告已验证、验证失败、无法验证。当前已完成 **M1 受控样例证据闭环**；**M2 对话整理**和 **M3 需求驱动规划**已部分实现。DeepSeek Flash 已在单个公开样例上真实运行，但模型规划结果仍有测试数据与预期状态错误；尚未实现外部项目隔离、MCP 或宿主钩子。

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

Pi 依赖采用 `@earendil-works/pi-ai` 0.87.1。pnpm 的两个非必需传递依赖构建脚本已明确禁用；DeepSeek Flash 的真实调用已通过，Kimi 尚未做账户实测。

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

豆包、硅基流动、百炼目前**没有** VibeGuard 的同格式入口，不能仅设置密钥就使用 `--provider doubao/siliconflow/bailian`。它们各自还需要确认接口地址、模型 ID、账户地域或权限，并通过真实调用验证；接入后才会加入上面的默认列表。当前 `verify --variant ...` 是受控演示命令，**还不能**执行 `vibeguard verify task.json --provider deepseek` 这样的完整自动验收。M2/M3 的真实模型流程是 `resolve` → `plan`，模型计划执行与外部项目隔离仍在开发。

## 冻结计划并执行（M3 人工样例）

M3 的程序规则要求每条当前有效要求都有检查目标，或明确说明暂时无法检查；已取消的要求不能重新变成必需项。计划包含 HTTP 操作和预期断言，程序固定计划摘要后才执行。当前演示计划仍由人手写，下面的命令用于验证执行和覆盖规则，**不证明模型已经会自动规划**。

```powershell
node dist/cli.js demo-plan --variant correct
node dist/cli.js demo-plan --variant faulty
node dist/cli.js demo-plan --variant unavailable
node dist/cli.js planned-report <运行ID>
```

正确版的 150/149 门槛检查通过，但“一次使用”仍未检查，因此整个任务输出 `UNVERIFIABLE`。缺陷版会在 149 元订单的保存记录中发现 20 元错误优惠，输出 `FAILED`。服务不可用时输出 `UNVERIFIABLE`。三次运行使用相同的计划摘要，目标代码摘要随变体变化；报告及逐步 HTTP 证据保存在 `.vibeguard/planned-runs/`，可在新进程读取并核对哈希。`demo-plan` 的退出码按整个任务结论给出：0 已验证、1 失败、2 无法验证、3 参数或内部错误；上面的旧 `verify` 命令仍按门槛检查范围给出退出码。

`plan` 已提供模型规划入口：它读取一份**已完成要求整理**的记录与用户授权的 API 描述文件，让模型提出检查，再由程序拒绝漏项、越界接口和自行提交的结论。这个入口目前只冻结并保存**结构合格的候选计划**，尚不能从该命令直接执行模型计划。真实 DeepSeek Flash 计划已保存，但把结算成功状态误写为 200（演示 API 返回 201），且在不同检查间复用了同一张券，使门槛反例可能被“券已用过”混淆；因此不能把计划冻结当作验收通过。

```powershell
node dist/cli.js plan --resolution <要求整理ID> --profile fixtures/profiles/coupon-api.json --provider deepseek
node dist/cli.js plan-record <计划摘要> --format json
```

受控演示报告现在把用户原话、每条要求的结论和执行证据 ID 放在一起。本地文件哈希只能发现读取时的文件变化；若干活 Agent 与 VibeGuard 共享证据目录的写权限，不能据此宣称证据无法伪造。
