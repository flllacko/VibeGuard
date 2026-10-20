# D3：要求改口后的重新验收

日期：2026-10-20。本轮把已有要求版本、规划、运行和历史证据串成可复现的修订实验，没有改变引擎的判定规则，也没有开发桌面或新平台。

## 要证明什么

“以前通过”只能证明以前的要求和交付。用户改口后，必须先重新确认当前要求，再生成新版计划；修复交付后可以复用新版标准，但必须重新运行取得证据。

本轮使用[合成任务](../fixtures/evaluations/d3-revision-reverification.json)：最初要求把文字转成大写，随后自然表达改为小写。业务规则、交付和独立参考答案都在样本里，验收引擎没有大小写专用分支。

## 真实执行链路

| 步骤 | 实际发生的事 | 结果 |
| --- | --- | --- |
| 初次验收 | Flash 从原要求规划，Docker 运行原交付，取得 2 条功能响应 | 已验证 |
| 整理改口 | 真实 Flash 将自然回复理解成要求修订，保留接口格式及修改原话 | 新清单待确认，没有直接变成已确认 |
| 尝试旧计划 | 已登记修订后，再申请执行旧计划 | 拒绝，Docker 客户端调用 0 次 |
| 尝试未确认清单 | 新清单尚未再次确认就准备项目 | 拒绝 |
| 新要求验旧交付 | 程序预置再次确认，Flash 重新规划，运行同一旧交付 | 验证失败 |
| 修复后复验 | 换成修复交付，重新固定副本，复用新版计划的标准和步骤 | 已验证，没有额外规划调用 |
| 回看历史 | 要求与交付均已更新后读取初次报告 | 仍可读，仅对应原要求、原计划和原交付 |

真实修订原话：

> 输出改成全小写，MiXeD 应该变成 mixed，blue sky 应该变成 blue sky。其他接口格式不变。

模型整理后的当前要求保留 HTTP 200、JSON text 和两个输入，预期更新为 `mixed` 与 `blue sky`；旧的大写原话作为历史来源保留，没有被当成当前预期。

旧交付按新要求执行时，实际观察为：

```text
POST /format {"text":"MiXeD"}
HTTP 200 {"text":"MIXED"}
预期 text="mixed" → 失败
```

另两条真实观察为 `blue sky → BLUE SKY`、模型自行补充的 `HELLO WORLD → HELLO WORLD`，也不满足新版小写标准。修复后相同新版计划的三个检查全部满足。

## 运行和版本

| 范围 | 运行编号 | 结论 |
| --- | --- | --- |
| 原要求与原交付 | `4b4836ed-5617-4ffb-a6df-fbef00799d3c` | VERIFIED |
| 新要求与原交付 | `97c5934e-325f-40b6-9398-b3554aa883df` | FAILED |
| 新要求与修复交付 | `b0bd2f08-69c4-455a-9eba-2a3575a8863a` | VERIFIED |

前两次交付摘要相同，要求摘要和计划摘要不同，证明失败不是偷偷更换交付导致。修复后交付摘要改变；新版标准和步骤不变，计划重新绑定新交付。不能拿旧通过结论代替新运行。

## 验证与成本

- `pnpm build` 成功；`pnpm test` **154 项通过**。新增回归检查覆盖修订后执行/规划拦截、未确认版本拒绝、历史报告保留，以及执行过程中要求变化后不通过且仍清理资源。
- “执行过程中改口”使用模拟 Docker，属于程序检查；本轮真实模型修订发生在两次真实容器运行之间，不冒充真人实时插入。
- 三次真实模型响应：初次规划、修订理解、新版规划各一次，没有反馈重试；**2,988 输入 / 989 输出 token，SDK 估算 $0.001631616**，非供应商账单。修复交付复用新版规划，记录零新增模型费用。
- 原验证进程退出后，以不带本项目模型密钥、PATH 无 Docker 的新 CLI 进程读回三份报告和八条功能证据。原报告在修订后仍可读。
- 执行前后十个源码文件哈希一致。正常运行的容器及临时镜像已回收，Docker 标签查询无遗留。

原始记录位于 `.vibeguard/evaluations/d3-revision-20261020-first/`：`event-*.json` 为逐阶段记录，另有三份 `*-report.md`、`initial-plan.json`、`revised-plan.json`、`revision-review.json`、`revised-model-input.json`、`summary.json`、`restarted-readback.json`、`postcheck.json`、测试输出和 `data/`。本地记录被 Git 忽略，源码保留样本与通用评估入口。

## 自己看结果

在仓库目录执行，只读已有记录，不再调用 API 或启动 Docker：

```powershell
# 改口后旧交付为什么失败：原话、当前要求和真实响应都在报告里
node dist/cli.js project-report 97c5934e-325f-40b6-9398-b3554aa883df --data-dir .vibeguard/evaluations/d3-revision-20261020-first/data

# 修复后的新证据
node dist/cli.js project-report b0bd2f08-69c4-455a-9eba-2a3575a8863a --data-dir .vibeguard/evaluations/d3-revision-20261020-first/data
```

要重新实验，需可用 Docker、已缓存基础镜像和 API 环境变量；使用尚不存在的新目录，`run` 会付费并修改该实验目录内的合成交付：

```powershell
node dist/evaluate-revision-run.js prepare --case fixtures/evaluations/d3-revision-reverification.json --out D:/CodexWork/VibeGuard/.vibeguard/evaluations/revision-new-run
# 查看 outgoing-review.md；仅含合成要求、修订和契约，无源码或独立参考答案
node dist/evaluate-revision-run.js run --out D:/CodexWork/VibeGuard/.vibeguard/evaluations/revision-new-run --allow-model --allow-docker
# 复用已有读回工具；每个目录只保存一次批量读回记录
node dist/evaluate-external-run.js readback --out D:/CodexWork/VibeGuard/.vibeguard/evaluations/revision-new-run
```

评估最多六次响应：初次规划、修订理解、新版规划各最多一次反馈修正；认证、网络或不完整响应不靠格式重试补救。失败时保存 failure.json 及已经产生的记录，不覆盖同目录重跑。

## 不能据此宣布的事

原始要求及两次确认均由评估程序预置，修订原话也由开发助手编写；真实模型负责修订理解和规划，真实容器提供执行观察。它不是盲评、真人确认或真实宿主端到端体验。

**拦截发生在修订已经进入 VibeGuard 审查记录之后。** 当前仅传计划编号的执行入口不会自行去所有 Agent 搜索最新消息。用户在平台里发了改口、却尚未交给 VibeGuard 的情况，本轮没有解决，不能宣传为自动跟踪最新要求。

桌面、安装包、MCP 接入改造、新平台、浏览器、数据库和并发未执行；运行支持范围未扩张。

下一最小动作：执行入口显式带入最新采集快照，遇到尚未审查的新用户消息先停止执行，要求整理和确认后再验收；在该采集时点核对当前性，不把旧快照冒充实时历史。
