# VibeGuard 开发原型

VibeGuard 验收 AI Agent 的交付：保留用户原话，独立取得实际证据，分别报告已验证、验证失败、无法验证。当前已完成 **M1 受控样例证据闭环**，正在实施 **M2 完整对话与有效要求整理**。尚未实现动态验收规划、外部项目隔离、MCP 或宿主钩子。

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
node dist/cli.js resolve --task fixtures/conversations/coupon-complete.json --provider openai --model <模型ID>
node dist/cli.js resolution <要求整理ID> --format json
```

将 `<模型ID>` 替换为所选提供商实际支持的模型 ID，`<要求整理ID>` 替换为上一条命令输出的 ID。

`resolve` 调用 Pi 的模型 API，让模型提出要求新增、修改、取消事件；程序核对每条用户消息的去向及每段原话是否逐字存在。若缺模型凭据、模型输出错误或材料不完整，保存缺口并退出为“无法完成整理”。当前环境尚未配置模型 API 密钥，**真实模型理解能力未验证**。不要把密钥写进对话 JSON、项目文件或聊天消息；用所选提供商的环境变量配置。消息都有处理记录也不能证明模型绝不会漏掉语义上的要求，正式报告仍要展示清单供人复核。

Pi 依赖采用官方 `@earendil-works/pi-ai` 0.87.1。pnpm 的两个非必需传递依赖构建脚本已明确禁用；当前计划先使用 OpenAI 路径，其他提供商使用前需单独验证对应依赖是否可运行。
