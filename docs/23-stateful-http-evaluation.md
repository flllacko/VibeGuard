# D3 增量：根据运行结果继续检查，而非只看首次成功

日期：2026-10-20。范围仍为 D3，未增加桌面、平台接入或浏览器能力。

## 为什么做这一轮

用户允许开发助手自行设计任务后，本轮选择“保存便签再读取”。它能暴露一种常见假完成：保存接口答复正确，实际保存的内容却不正确。这个业务只是验证 VibeGuard 的材料，产品代码没有加入便签专用规则。

开发助手编写的原话如下，不冒充用户提出的新业务需求：

> 实现便签保存与读取。提交 text 时去掉首尾空白后保存，返回 HTTP 201、id 和清理后的 text；再用该 id 读取，返回 HTTP 200 及相同的 text。本轮验收须包含 text 为"  Atlas  "的保存再读取，以及 text 为""时返回 HTTP 400、error 为"EMPTY_TEXT"。只验上述行为。

[样本与三份交付](../fixtures/evaluations/d3-notes-roundtrip.json)包含正确实现、答复正确但保存错误的实现、启动退出的实现。项目用容器内存保存数据，本轮未验证数据库或跨重启保存。

## 实际发生了什么

1. 首轮真实 Flash 响应把 coverage 放错位置，还引用了不存在的标准。程序拒绝规划，没有执行业务检查；原始响应和费用均保留。
2. 修正通用规划提示，增加最多一次代码校验反馈修正。没有改动样本原话、三份交付或独立参考答案。
3. 增加明确的动态值比较：先捕获实际生成的 id，再在后续请求和断言中使用。固定字符串不会偷偷变成变量。
4. 相同样本复测，Flash 首次响应即通过校验，生成保存、按实际 id 读取、空文本拒绝三个步骤。同一标准和步骤重新绑定三份交付后真实运行。

| 交付 | 真实观察 | 结论 | 外部运行编号 |
| --- | --- | --- | --- |
| 正确 | 保存和读取均为 `Atlas`；空文本返回 400 / EMPTY_TEXT | 已验证 | `00236939-cebe-4d57-8de6-138de0009016` |
| 有缺陷 | 保存答复为 `Atlas`，读取却为 `  Atlas  `；空文本检查仍满足 | 验证失败 | `4c9a29a9-d506-4ecc-9ac7-edbbc4d40888` |
| 不可用 | 程序退出码 11，无功能请求证据 | 无法验证 | `e8adcf66-283c-4a5c-af31-893b0c181051` |

失败版本使用的实际资源 id 是 `971c4894-86d5-4330-b7df-97dd3f48c660`。读取证据为 `a00afa5d-23bf-4a15-b659-c20b6b4f3a5f`，保留了实际请求路径、HTTP 200 和包含空白的响应正文。成功状态码没有覆盖正文不符的事实。

## 通用改动

- 断言可选固定值 `equals` 或前步捕获值 `equalsCapture`，必须二选一；拒绝未知、未来或跨检查引用。数字捕获保持数字类型。
- 模型只能修正候选；仍须通过原有结构、要求覆盖、引用与接口范围校验。最多两次请求，认证、网络和不完整响应不自动重试。原始尝试及费用保留。
- 报告中的逐步证据按实际采集顺序展示；重启后无需模型即可读取。
- 评估器支持动态资源路径及独立进程读回。参考答案只供生成后的评估检查，不传入规划器。

相关实现：`planning.ts`、`plan-runner.ts`、`http-plan-proposal.ts`、`pi-plan-gateway.ts`、`external-plan.ts`、`external-runner.ts`、`evaluate-external-run.ts`。

## 怎样自己查看

在仓库目录执行，已有本机记录不需要再次调用 API 或启动 Docker：

```powershell
node dist/cli.js project-report 4c9a29a9-d506-4ecc-9ac7-edbbc4d40888 --data-dir .vibeguard/evaluations/d3-notes-20261020-retest/data
node dist/cli.js project-evidence 4c9a29a9-d506-4ecc-9ac7-edbbc4d40888 a00afa5d-23bf-4a15-b659-c20b6b4f3a5f --data-dir .vibeguard/evaluations/d3-notes-20261020-retest/data
```

重做实验会产生费用和测试容器。使用一个尚不存在的新输出目录：

```powershell
pnpm build
node dist/evaluate-external-run.js prepare --case fixtures/evaluations/d3-notes-roundtrip.json --out D:/CodexWork/VibeGuard/.vibeguard/evaluations/notes-new-run
# 先查看新目录中的 outgoing-review.md；run 才实际调用模型和 Docker
node dist/evaluate-external-run.js run --out D:/CodexWork/VibeGuard/.vibeguard/evaluations/notes-new-run --allow-model --allow-docker
node dist/evaluate-external-run.js readback --out D:/CodexWork/VibeGuard/.vibeguard/evaluations/notes-new-run
```

`run` 每个目录只能发起一次，避免误重复付费；`readback` 保存一次新进程核对记录。已有报告随时通过 `project-report` / `project-evidence` 读取。

## 验证、成本与边界

- 构建及 **146 项本地测试通过**。修正上限、费用累计、引用拒绝及动态字符串/数字比较有程序测试；模拟响应不是上表的验收证据。
- 原运行进程退出后，用不带本项目模型密钥、PATH 无 Docker 的新 CLI 进程读回三份报告、六条功能证据。
- 使用当前引擎实际重跑上一轮 230/30 的三个旧计划，仍分别得到已验证、失败、无法验证；没有重新调用模型。记录在 `amount-backward-compatibility.json`。
- 两轮真实模型共 **2 次响应、1,896 输入 / 1,161 输出 token**，含缓存输入与首轮失败，SDK 估算 **$0.001849104**，不是供应商账单。复测只用一次响应，未实际触发反馈修正；该分支仅通过程序测试。
- 真实复测执行期间七个核心文件哈希未变。各次正常运行已回收自身容器和临时镜像，最终 Docker 标签查询无遗留。

首轮记录：`.vibeguard/evaluations/d3-notes-20261020-first/`。复测、读回、成本、测试输出及旧计划兼容记录：`.vibeguard/evaluations/d3-notes-20261020-retest/`。这些本地原始记录被 Git 忽略，源码仓库保留复现实验样本。

这是开发助手设计并调试过的样本，不能当作盲评、总体准确率、真人原聊天要求审查或 MCP 完整闭环。运行范围仍限无需安装依赖的直接 Node HTTP 项目。桌面、安装包、新平台、浏览器、数据库、并发均未执行，避免把局部实测写成整个产品完成。

最小下一步：在现有 HTTP 范围增加一组独立任务，专门检查“计划漏掉要求时能否留下明确缺口”，然后再决定是否扩大运行范围。
