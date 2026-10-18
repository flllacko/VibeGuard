# VibeGuard 开发原型

VibeGuard 验收 AI Agent 的交付：保留用户原话，独立取得实际证据，分别报告已验证、验证失败、无法验证。当前已有受控 HTTP 样例、完整对话整理、需求驱动规划和主动 MCP 入口。新增**只读文件验收**：模型从当前要求生成计划，独立进程检查授权目录并保存文件清单、哈希与结论；真实技能安装案例得到 4 条已验证、2 条无法验证。见 [文件验收操作与实测](docs/10-readonly-file-verification.md)。尚未实现外部代码隔离运行、真实宿主完整自动接入或自动验收。

默认由用户说“用 VibeGuard 验收”后发起检查；自动验收作为后续可开启的模式，默认关闭。MCP 是 Agent 调用 VibeGuard 的工具入口，不会自动提供完整聊天记录，也不保证存在 `@VibeGuard` 入口。

新增**长聊天范围确认原型**：新采集的 Codex 文字历史先提议本次阶段及相关前文，用户选择后重新采集真实确认，再整理要求。选择不补齐图片或缺页，也不代表功能通过。见 [范围选择与使用说明](docs/13-task-scope-and-confirmation.md)。

已确认任务仅前文附件未解析时，可以先输出**可读文字候选**，保留图片、语义待定及执行证据缺口。真实 S1 已整理出 3 条候选并在原聊天读回，整体仍无法验证。见 [部分材料处理实测](docs/14-partial-material-requirements.md)。

新增**原聊天要求审查**：清单展示原话与 R/Q 编号，用户可回复“第2条改成……”“取消第3条”“Q1作为背景”，修改后展示新版，再确认。修订和确认从新采集的原始用户回复核对，不接受 Agent 代填结论；图片等材料缺口继续保留。已完成本地及 MCP 跨进程测试，真实平台需重载后验证真人流程；确认后尚未接入外部项目自动执行。见 [要求审查与修订说明](docs/15-requirement-review.md)。

修订入口现已接入**模型理解自然表达**，无需固定命令，例如“退款恢复那块这次先放下”。模型提出通用修订操作，程序核对真实原话、对象和版本，再展示新版；不逐个业务硬编码。复用现有模型配置，明确确认和历史读回不额外调用模型。已完成 DeepSeek Flash 小样本真实联调：保留首轮失败，修正后同组 8 例和新增 2 例符合预期，不能据此宣传一般准确率。见 [真实调用、问题与结果](docs/16-live-review-evaluation.md)。

## 统一接入向导

当前源码原型完成 `pnpm install`、`pnpm build` 后，Windows 可双击 **connect.cmd**，或运行：

```powershell
node dist/cli.js connect
```

选择 Codex 或 Claude Code → 查看改动 → 确认后合并 MCP 和对话采集配置 → 独立连接自检。平台要求的钩子信任仍需用户完成。已有配置会保留；重复安装不重复添加同一钩子。

```powershell
node dist/cli.js connect codex --dry-run
node dist/cli.js doctor codex
```

自检分别显示配置、工具连接、当前对话采集、项目读取及证据读回；未经真实平台运行的项目显示待确认。**当前不是已发布安装包，Claude 应用内实测与其他平台自动配置尚未完成。**操作、数据读取与写入边界见 [接入向导说明](docs/11-connection-wizard-and-plan-view.md)。

## 手动接入：生成填写说明

Codex 的设置界面可以直接添加 MCP，**不要求手改 TOML**。当前采集器随同一个 VibeGuard 源码包提供；配置 MCP 和采集 Hook 后，Hook 会从宿主取得当前会话身份，在主动验收前独立读取原文、登记任务。用户不用每换聊天都填写编号。MCP 与 Hook 各配置一次，不能声称只加 MCP 就自然获得聊天历史。

```powershell
pnpm build
node dist/cli.js setup codex
# Claude Code 的配置说明
node dist/cli.js setup claude-code
```

`setup` **只显示适合本机的表单字段和配置片段，不修改平台配置**，不打印密钥。Codex 的非受管 Hook 还须用户在平台中审查并信任；其输入改写会允许该次验收工具调用。Claude 入口使用官方 SDK 本地读取，不调用 Anthropic API。完整操作与限制见 [用户接入说明](docs/09-user-mcp-setup.md)。

2026-09-30 的早期检查使用手工构造的 Hook 输入。2026-10-14 已在两条真实 Codex 聊天直接调用 MCP，宿主 Hook 自动登记了各自原文，分别取得 49/19 条用户文字消息、185/53 条助手文字消息；身份、原文摘要和消息 ID 核对未串线。第二条首次暴露“最新轮次只有工具事件”的采集缺陷，修复并真实复测通过，见 [宿主实测记录](docs/12-live-codex-capture-test.md)。Claude 仍只有 SDK 合成转录与 MCP 测试；任务范围和非文字材料待处理，不能据此宣称真实业务任务全部完成。

## 主动验收与 MCP（M5 原型）

CLI 与 MCP 共用同一个验收服务。先构建，再登记原始对话：

```powershell
pnpm build
node dist/cli.js register-task --task fixtures/conversations/coupon-complete.json
node dist/cli.js verify-task <登记输出的taskRef>
node dist/cli.js verification <运行输出的runId>
```

`verify-task` 自动读取环境变量，默认 DeepSeek Flash。**未绑定执行计划的外部任务只整理要求，仍报告无法验证**；绑定只读文件计划可实际检查文件，绑定内置样例计划可执行 HTTP。MCP 提供 `verify_task`、`get_verification`、`read_evidence` 三个工具，启动文件为 `dist/mcp-entry.js`；支持本地 MCP 的宿主填写启动命令即可连接。

Codex 的早期固定会话试点仍保留：`node dist/cli.js capture-codex <会话编号>`，或 MCP 启动参数 `--codex-thread <编号>`。新接入优先使用上面的采集 Hook，由平台提供当前会话身份，不把一个全局固定编号误用于所有聊天。详见 [Codex 真实会话读取试点](docs/08-codex-history-pilot.md)。

具体启动配置、长任务阶段范围的当前限制和已实测证据见 [主动验收与 MCP 使用说明](docs/07-mcp-prototype.md)。目前需要下载源码构建，尚未发布全局安装包，也未修改任何宿主的全局配置。

## 只读文件验收：已有真实任务证据

适合“复制文件夹、安装技能文件、完整保留素材”等任务。项目配置声明参考源和交付位置，**不写死本次验收标准**；模型从整理好的要求决定查哪些位置、比较结构还是内容。

```powershell
# 把占位符换成实际输出；file-profile.json 的格式见下方文档
node dist/cli.js file-plan --resolution <要求整理ID> --profile file-profile.json
node dist/cli.js register-task --task task.json --file-plan <计划摘要> --file-profile file-profile.json
node dist/cli.js verify-task <taskRef>
```

默认 DeepSeek Flash，自动读环境变量。规划需要模型调用；**文件执行、保存和读回证据不调用模型**。同样的 taskRef 会重新观察文件状态；状态变化后生成新运行，不复用旧通过结论。MCP 调用仍只传 taskRef，不能上传检查脚本、路径或 verdict。

真实历史案例：源与交付均 138 文件、13 子目录，逐文件 SHA-256 一致；SKILL.md 在第一层，references/assets 完整。宿主是否加载、是否已向用户说明触发方式不属于本轮文件证据，仍无法验证。详细格式、使用步骤、开发中发现的模型规划错误与边界见 [文件验收说明](docs/10-readonly-file-verification.md)。**构建后要重载正在运行的 MCP，才能发起新增文件执行。**

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

需要 Node.js 24 与 pnpm。M1 运行受控样例；D2 另提供已准备项目副本的 Docker 启动检查，并已做真实容器实测，尚未接通外部任务的动态功能验收。架构和后续阶段见 [文档索引](docs/00-README.md) 与 [实施状态](docs/implementation-status.md)。

## 导入完整对话与整理要求（M2 开发中）

### 外部项目准备（D1）

已实现独立的 `external_project` 准备类型：项目运行配置、实际文件副本、确认要求与宿主采集绑定。`project-prepare --profile FILE --review REVIEW_REF --current-task FRESH_TASK_REF` 登记项目，`project-inspect PROJECT_REF` 复核副本；二者均通过 `node dist/cli.js` 调用。后续使用输出的任务编号调用原有 CLI/MCP。准备结果始终为“尚未执行 / 无法验证”，不是通用动态验收已完成。

副本默认排除依赖、工具数据及常见本地密钥文件名，保留排除账目；证据目录必须在项目目录外。源码变更需新副本。配置及边界见[外部项目准备说明](docs/18-external-project-preparation.md)。

### Docker 运行检查（D2）

已经准备的项目可以显式启动检查。当前限本地缓存的官方 Node 24 镜像和无需安装依赖的直接 JavaScript 入口；不提供外网、宿主端口或外部数据库。

```powershell
# 首次主动准备基础镜像；运行器不会自动下载
docker pull node:24-bookworm-slim
node dist/cli.js project-runtime PROJECT_REF
node dist/cli.js runtime-report RUN_ID
```

以上命令支持 `--data-dir PATH`。记录实际就绪请求、日志、退出和清理；正常就绪仍是任务“无法验证”，不能证明功能完成。MCP 外部项目查询仍为准备状态，动态功能验收与 `.exe` 尚待后续阶段。详见 [Docker 运行说明](docs/19-docker-runtime.md)。

`intake` 接受一份 JSON 对话文件，保存消息原文、顺序、任务边界、来源和内容摘要。示例格式见 `fixtures/conversations/coupon-complete.json`。`transcriptCoverage.level: complete` 是提交者对**明确任务边界内**材料的声明；它本身不能证明宿主没有漏发消息。程序还会检查首尾 ID、序号缺口和摘要来源。

```powershell
node dist/cli.js intake --task fixtures/conversations/coupon-complete.json
node dist/cli.js resolve --task fixtures/conversations/coupon-complete.json --provider deepseek
node dist/cli.js resolution <要求整理ID> --format json
```

`<要求整理ID>` 替换为 `resolve` 输出的 ID。`--provider deepseek` 默认使用 `deepseek-flash`；想用 Pro 时才加 `--model deepseek-v4-pro`。`resolve` 需要对应 API Key，下面有配置方法。

`resolve` 调用 Pi 的模型 API，让模型提出要求新增、修改、取消事件。程序先按原文标点生成分段，模型在同一次调用中说明每段属于**要求、操作授权、背景或讨论、待确认**，并关联要求 ID；程序检查漏段、重复 ID、逐字引用和关系，保留“原话 → 拆分要求”的记录。授权不能同时生成新要求，待确认片段使整理保持不完整。相邻片段重申同一规则可关联已有要求，并保留原话。分段无遗漏只是结构检查；模型仍可能错分类、扩写或合并要求，不能当成语义正确率。

DeepSeek Flash 已复测两段真实 Codex 材料：技能安装拆成六项，“确认”归为授权；学校案例此前漏掉的“询问或引导用户”进入候选清单，但材料仍为 partial。一份新的**人工合成**导出任务通过真实 stdio MCP 整理，金额两位改三位、其余要求保留；没有执行证据，仍报告无法验证。见 [要求拆解复测](docs/intent-coverage-evaluation-2026-09-30.md)。若凭据、输出格式或材料有缺口，保存原因，不宣布完整整理或验收通过。

MCP 默认只返回分段计数；`get_verification(includeReport: true)` 才附详细分段原话，减少普通工具调用的上下文体积。`resolution <ID>` 可查看完整拆解。整理提示词更新会改变复用键，旧整理不会被当成新版结果；**更新并构建源码后，已运行的 MCP 服务需要重载**。

已有计划时，`node dist/cli.js plan-record <计划摘要>` 现在直接展示“用户原话 → 怎样算做到 → 执行检查 → 尚缺证据”的可读清单，`--format json` 保留原始格式。已绑定计划的 MCP 报告通过 `get_verification(includeReport: true)` 返回 `acceptancePlan`；清单不等于通过证明，也不记录人工审批。

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
