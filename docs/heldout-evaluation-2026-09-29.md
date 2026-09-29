# VibeGuard 首次保留样本开发评估

日期：2026-09-29。目的：检查模型在**新对话**中能否整理有效要求、生成真正能区分正确与缺陷交付的计划。这是合成样本的开发评估，不是产品可靠性统计。

## 评估顺序与隔离

1. 先写两份新任务对话和人工标准答案，见 `fixtures/conversations/heldout-*.json`、`fixtures/evaluation/heldout-gold.json`。模型调用前没有根据这些样本调整需求整理或规划提示词。
2. DeepSeek Flash 只收到完整任务对话、已有要求状态，以及规划时的 `coupon-api-neutral.json` 接口说明。人工标准答案、缺陷规则和评估脚本**没有**传给模型。中性接口说明不提供 120 元与 15 元的答案。
3. 用同一冻结计划检查四个独立启动的受控实现。评估程序把真实 HTTP 请求和响应保存到 `.vibeguard/planned-runs/`，并另外保存逐项对照表。

## 需求整理人工复核

| 合成任务 | 人工标准答案 | 本次模型输出 | 结论 |
| --- | --- | --- | --- |
| 优惠券多轮改口 | 当前：满 120 元减 15 元；每张券限一次。取消：过期券限制 | 两条当前要求、一条取消要求；引用了对应用户原话，旧 80/12 未残留为当前要求 | 本例符合 |
| 邮箱密码登录 | 当前：正确密码发 Token；错误密码 401；Token 有效期 2 小时。取消：连续错误锁定账号 | 三条当前要求、一条取消要求；未把 Agent 的“已完成”当成用户要求 | 本例符合 |

需求整理运行 ID：优惠券 `9d216f23-2317-4801-af28-9d4f48bd7ed7`；登录 `e99824f0-4b27-4f28-b72b-d3c6a76498cb`。这些是人工对照结论；程序的 `resolutionComplete` 只证明消息去向与引用结构完整，不能自动证明语义无遗漏。

## 计划与实际执行

优惠券计划摘要：`27a034bbd681e67e1a2fa0b02fbef6fdcd8b5d631a6a639458af7fef40fff266`。人工检查发现它用独立新券验证 12000 分订单预期优惠 1500 分、11999 分订单预期不优惠，并用同一券两次结算检验限用一次；没有复活被取消的过期规则。

| 受控实现 | 预期 | 实际 | 证据与运行 ID |
| --- | --- | --- | --- |
| 门槛 12000 分、优惠 1500 分 | VERIFIED | VERIFIED | `4727f66c-6bbc-4b4a-ad4c-19d58c7b4858` |
| 旧门槛 8000 分、优惠 1500 分 | FAILED | FAILED | 低于 12000 分的真实订单获得 1500 分优惠；`d28f6d82-d89d-4ee4-88b3-e3458d9482d3` |
| 门槛 12000 分、旧优惠 1200 分 | FAILED | FAILED | 达标订单实际优惠 1200 分，计划预期 1500 分；`ec8a14ef-36b2-4db8-9df9-9ed098e98bc4` |
| 服务已关闭 | UNVERIFIABLE | UNVERIFIABLE | 请求无法完成，未冒充业务失败；`dcbf9319-943c-4be8-a17c-7f8cd1ecf992` |

完整评估摘要：`.vibeguard/evaluations/502ca592-313b-41dc-b827-8e1299201008.json`。脚本还要求两种缺陷的 FAILED 有对应的请求、实际响应和相反的冻结预期，不只比较最终标签。

复现命令（在仓库根目录）：

```powershell
pnpm build
pnpm test
node dist/cli.js resolve --task fixtures/conversations/heldout-coupon-revisions.json --provider deepseek
node dist/cli.js resolve --task fixtures/conversations/heldout-login-revisions.json --provider deepseek
node dist/cli.js plan --resolution <新优惠券要求整理ID> --profile fixtures/profiles/coupon-api-neutral.json --provider deepseek
node dist/evaluate-heldout.js --plan <新计划摘要>
```

重跑模型可能产生不同 ID、计划和结果；上表是这一次观察。已有冻结计划可直接用于最后一条命令，无需再次调用模型。

## 结果边界与下一步

- 两份需求整理、其中一份计划，只各调用模型一次。样本是本项目作者合成的短任务；不能据此估计错误放行率、漏项率或与现有测试工具的差距。
- 受控实现由本项目创建，还没有验收外部 Agent 交付，也没有容器隔离或自动宿主钩子。
- 规划器写出的预期可能本身有错。此次通过正确实现对照和人工标准答案检查了预期；产品化还需要更多独立样本与机器可核对的前置条件、业务结果门禁。
- 下一轮应扩展到真实长任务、登录等不同领域，并把正确交付误报、缺陷漏报、成本和耗时一起记录。
