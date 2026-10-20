# D3：告诉用户缺哪一层证据

日期：2026-10-20。继续现有 D3，没有扩大桌面或平台接入范围。

## 这轮解决什么

原有代码已拒绝完全没有规划去向的要求，但“无法验证”还需要说明原因。本轮给外部 HTTP 报告增加可读的覆盖账目和缺口：

| 情况 | 报告如何说明 |
| --- | --- |
| 要求存在，但没有完整可执行检查 | 计划缺口：保留原话、缺少什么入口、下一步补什么 |
| 计划已有步骤，但未运行或工具失败 | 执行缺口：列出检查/步骤、请求、实际错误和缺少的响应 |
| 依赖条件尚未实际核对 | 前置条件缺口：列出未观察的条件 |
| 运行未完整结束或清理未确认 | 运行缺口：保留已有观察，不把片段提升为已验证 |

这些字段由已存计划、执行记录和真实响应计算，不让模型填写“覆盖得分”。同一步骤关联多条要求时只统计一次；收到 HTTP 响应也不等于断言满足。计划条目齐全仍可能发生语义误解，程序没有解决全部自然语言遗漏问题。

实现位于 `src/http-coverage.ts`，外部报告读取和渲染复用它。旧存储格式不改写，读取时根据归档材料生成新增字段；读报告不调用模型或重新执行项目。

## 新任务与真实结果

用户允许自行迭代后，开发助手设计了三条要求：整数换算、负数拒绝、独立审计记录。前两条有 HTTP 契约，第三条没有审计读取地址或工具。业务和数值只存在于[评估样本](../fixtures/evaluations/d3-known-coverage-gap.json)，产品代码不增加换算或审计关键词判断。

三条要求的拆分、原话引用及确认由评估程序预置。真实模型负责从这些要求和接口契约生成标准、步骤及缺口；本轮不验证对话提取或真人确认能力。独立参考答案、源码和变体标签不发送给模型。

| 交付 | 本次要求结果 | 整体结论 | 运行编号 |
| --- | --- | --- | --- |
| 可观察 HTTP 行为正确 | 2 条已验证，审计记录无法验证；5 步均取得响应 | 无法验证 | `3ea57dcb-2c3b-4c40-ba78-9cca9d525b16` |
| 负数拒绝有缺陷 | 1 条已验证、1 条失败、1 条无法验证；5 步均取得响应 | 验证失败 | `ae6cc0de-a594-4f6e-a06a-a7b881718ff5` |
| 启动退出 | 3 条无法验证；2 条是执行缺口，审计条目是计划缺口；无功能响应 | 无法验证 | `995b7129-38c0-49ec-9e4f-9e686ebc8ad7` |

缺陷版实际向 `POST /scale` 提交 `{"value":-3}`，返回 HTTP 200 / `{"result":-21}`，而冻结计划要求 HTTP 422 / NEGATIVE_VALUE。证据编号：`dfe8ab71-5d0f-4f04-8bd6-6e0069a65cf9`。未知审计结果不会掩盖这条已观察到的失败。

“正确”变体只指已给 HTTP 行为正确，不表示整个交付正确。即使所有已安排的步骤成功，审计要求没有观察证据，整个任务也不能已验证；不能从这里推断审计记录实际存在或不存在。

## 首轮失败与通用修复

首次请求生成了一个无法执行的审计 criterion，其 checks 为空。程序反馈后，模型用换算请求占位，却仍把该要求列为 unverifiable 并关联了 criterion。两次均被原有规则拒绝，首轮没有执行容器或功能检查。

修复是明确通用输出规则：完全无法检查的要求只放 coverage，criterionIds 为空并解释缺口；可执行标准至少有检查；partial 只关联实际检查并保留剩余缺口。没有放宽校验、自动删要求、替模型补占位请求或修改独立标准答案。

新目录使用完全相同的任务、交付和外发输入复测，首次模型响应即合法；只改变通用系统提示。原始失败和两次响应均保留。每轮调用仍最多一次反馈修正，不因为想要成功就无限重试。

## 实际验证与费用

- `pnpm build` 成功；`pnpm test` **151 项通过**。新增检查涉及缺口区分、失败与未知并存、共享步骤去重、未完成记录、原话引用和参考答案隔离；模拟传输不作为真实验收证据。
- `evaluate-external-run.js run` 实际调用 DeepSeek Flash，再执行三份 Docker 交付。复测评估的 `failures` 为空，同时核对逐条要求，未只核对整体状态。
- 原执行进程退出后，`readback` 用不带本项目模型密钥、PATH 无 Docker 的新 CLI 进程读回三份报告、十条功能证据。另一个新进程核对新增 coverage 与执行时相同，并读回上一轮便签失败报告，结论仍失败。
- 两轮执行前后各八个核心文件哈希一致；任务和外发输入摘要一致。各次容器/临时镜像清理完成，最终 Docker 标签查询无遗留。本轮启动了已有 Docker Desktop，没有安装依赖或修改全局 Agent 配置。
- 含首轮两次失败响应及复测一次响应，合计 **3 次真实响应、4,307 输入 / 3,297 输出 token**，SDK 估算 **$0.00487218**，不是账单。仅复测为一次响应、$0.00153。

首轮：`.vibeguard/evaluations/d3-coverage-gap-20261020-first/`；复测：`.vibeguard/evaluations/d3-coverage-gap-20261020-retest/`。复测目录包含三份可读报告、summary.json、restarted-readback.json、postcheck.json、测试输出、前后摘要和 data 中的原始记录。目录被 Git 忽略，样本随源码提交。

后核对小脚本曾因相对导入路径错误未运行；修正路径后成功，不影响已存运行结论或费用，也没有修改验收标准。

## 自己查看

在仓库目录执行，下面两项只读本地记录：

```powershell
# 两条成功但整体仍无法验证：查看审计要求的计划缺口
node dist/cli.js project-report 3ea57dcb-2c3b-4c40-ba78-9cca9d525b16 --data-dir .vibeguard/evaluations/d3-coverage-gap-20261020-retest/data

# 计划有了但没有响应：查看执行缺口
node dist/cli.js project-report 995b7129-38c0-49ec-9e4f-9e686ebc8ad7 --data-dir .vibeguard/evaluations/d3-coverage-gap-20261020-retest/data
```

重新实验会付费并启动测试容器，需准备可用 Docker、缓存基础镜像和 API 环境变量；使用一个新的输出目录：

```powershell
node dist/evaluate-external-run.js prepare --case fixtures/evaluations/d3-known-coverage-gap.json --out D:/CodexWork/VibeGuard/.vibeguard/evaluations/coverage-new-run
# 查看该目录的 outgoing-review.md 后再运行
node dist/evaluate-external-run.js run --out D:/CodexWork/VibeGuard/.vibeguard/evaluations/coverage-new-run --allow-model --allow-docker
node dist/evaluate-external-run.js readback --out D:/CodexWork/VibeGuard/.vibeguard/evaluations/coverage-new-run
```

## 未执行与下一步

本轮是开发样本复测，不是盲评、总体准确率或任意项目可用的证明。支持范围仍为无需依赖安装的直接 Node HTTP 项目。真人原聊天完整闭环、桌面、安装包、新平台、数据库、浏览器和并发均未执行，遵守 D3 范围。

最小下一步：检查同一原话修订后重新规划、旧计划不能冒充新要求通过的整条流程，继续复用当前运行器和证据存储。
