# 输入范围与拒绝行为：规划修正及实测

日期：2026-10-22。

## 解决了什么

上次真人任务只要求接口接收整数，但规划器额外要求验证非整数的错误处理，导致本来有实际执行证据的要求仍有计划缺口。本轮区分：

- “接收整数/字符串”：先验证该输入范围内的功能，不自动添加范围外拒绝要求。
- “非整数必须返回 422”：属于明确要求，必须安排相应检查。
- “返回错误但未规定形式”：现有运行器只能精确比较状态码和 JSON；不能随便填一个错误码代替未知预期，应保留缺口。
- 其他要求没有观察入口：继续显示无法验证，不能因简化范围而删掉。

只修改规划提示和一次结构修复的说明，不改变三态裁决、已有计划或历史报告。空检查仍不能通过代码校验，没有增加业务数值判断或自动把 partial 改成 planned。

## 真实模型实测

新增 `fixtures/evaluations/input-domain-contrasts.json` 和 `src/evaluate-input-domain.ts`。六组开发者编写样本涵盖：整数功能、明确拒绝非整数、拒绝形式未知、字符串处理、明确拒绝空字符串、额外审计要求无观察入口。

参考标准在 API 调用前冻结，只把要求及接口说明传给 DeepSeek Flash；参考答案、交付源码及真实聊天不发送。每次首次结构失败至多修正一次，所有原始响应保留。

| 轮次 | 观察 | 模型响应数 | SDK 估算费用 |
| --- | --- | --- | --- |
| r1 | 5 组符合标准；未知错误形式仍被填入猜测的 400 并标 partial | 6 | $0.007685016 |
| r2 | 修正后未知错误形式保留缺口；审计要求被输出为空检查，两次结构校验失败 | 9 | $0.013539732 |
| r3 | 六组均符合原先冻结的标准，首次响应均合法 | 6 | $0.007583736 |

三轮案例及参考标准一致；没有为通过修改预期。r3 是开发样本回归，不是盲评或产品总体准确率。语义边界依靠模型理解，代码仍不能保证识别所有越界标准。错误形式未知时的缺口也反映当前精确断言工具的限制，不能推导成“所有错误响应都必须由用户指定完整 JSON”。

本地材料位于 `.vibeguard/evaluations/input-domain-20261022-r1`、`r2`、`r3`，保留准备输入、清单哈希、每组计划、失败详情、原始响应及用量。`.vibeguard` 不提交 Git。

## Docker 功能结果

新合成任务：整数 count 不小于 37 时 flag=true，否则 false。数值只存在于测试材料/交付中；要求拆分及确认由评估器预置，不冒充真实用户确认。

真实 Flash 一次生成计划，三个交付复用相同标准/步骤，未把参考答案交给规划器或运行器：

| 交付 | 实际结果 | 外部运行编号 |
| --- | --- | --- |
| 正确 | VERIFIED；5 个响应，2 项要求有证据 | `382c1087-aded-4072-a617-f593e6d08a7d` |
| 边界错误 | FAILED；count=37 实际 flag=false，计划预期 true | `ee3e5fbd-574e-4816-b006-3c0c4526807f` |
| 启动退出 | UNVERIFIABLE；无功能响应，保存启动失败原因 | `8f2517b1-e5bc-480e-9006-dc4b0ed0442e` |

正确交付的 36→false、37→true 和缺陷交付的 37→false 均来自真实 HTTP 观察。新 CLI 进程不带模型密钥且 PATH 无 Docker，读回三份报告及全部十条功能证据。归档及现场只读查询均确认本次容器/临时镜像清理完成。

材料根目录：`.vibeguard/evaluations/input-domain-runtime-20261022-r1`，其中 `correct-report.md`、`faulty-report.md`、`unavailable-report.md` 为可读结果，`summary.json`、`restarted-readback.json`、`live-cleanup-check.json` 为对应记录。

本轮合计含失败尝试共 22 个模型响应、32,001 输入/22,324 输出 token，SDK 估算 $0.03002928，非账单。Docker 实测生成计划占一次响应；执行及读回没有新增模型调用。

## 验证命令

在仓库根目录，已安装 Node 的终端中执行；本机 Node 若未在 PATH，使用实际绝对路径。

```powershell
node node_modules/typescript/bin/tsc --project tsconfig.json
node --test dist/tests/http-plan-proposal.test.js dist/tests/external-plan.test.js dist/tests/plan-review.test.js

# 只读本轮已有归档；不会调用模型或重新运行交付
node dist/cli.js project-report ee3e5fbd-574e-4816-b006-3c0c4526807f --data-dir .vibeguard/evaluations/input-domain-runtime-20261022-r1/data
node dist/cli.js project-evidence ee3e5fbd-574e-4816-b006-3c0c4526807f a56f26b5-6c0c-4aba-88e1-c162bc90a227 --data-dir .vibeguard/evaluations/input-domain-runtime-20261022-r1/data
```

相关 16 项测试通过；修改结构反馈后，其中 4 项再次通过。构建成功。全套测试未执行：本轮没有改执行器、宿主协议和存储格式，验证集中在规划结构、绑定、实际模型及容器链路。

如需新增一轮付费规划评估，先 prepare 到新的空目录，查看 outgoing-inputs.json，再 run；旧目录不能覆盖或重复付费运行：

```powershell
node dist/evaluate-input-domain.js prepare fixtures/evaluations/input-domain-contrasts.json D:/CodexWork/VibeGuard/.vibeguard/evaluations/input-domain-new
node dist/evaluate-input-domain.js run D:/CodexWork/VibeGuard/.vibeguard/evaluations/input-domain-new --allow-model
```

## 历史与剩余范围

上次原生计划 `a8351dbc-ca2c-4a6f-91ec-478c673157e9` 与原生报告文件 SHA256 前后一致，仍保留当时“3 项已验证、1 项无法验证”，没有改写成通过。

本轮未执行：新的真人宿主验收、其他平台、任意项目自动识别、桌面、安装包、浏览器及数据库检查。原生已加载 MCP 进程也未重载，不宣称其提示词已同步更新。

下一步最小动作：把项目启动方式和接口配置的准备做成辅助发现及可读确认，减少新项目接入时手填配置；只有确认后的项目配置才进入现有冻结、规划、执行与证据链路。
