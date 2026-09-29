# VibeGuard 技术设计

版本：0.1｜2026-09-27｜所有接口为产品拟实现契约，非现有可运行 API。

## 1. 技术选择与职责

| 部分 | 选择 | 说明 |
| --- | --- | --- |
| 主语言与运行环境 | TypeScript strict + Node.js 24 LTS | 编译产物执行，不依赖用户直接运行 TypeScript 源码 |
| 工程管理 | pnpm workspace | Core、CLI、MCP 与适配器复用类型和逻辑；锁文件纳入版本控制 |
| 模型与工具循环 | Pi 的 pi-ai、pi-agent-core 底层组件 | 使用实施时核实的包名和固定版本，封装在内部 ModelGateway 后面 |
| 数据契约 | Zod + 可导出的 JSON Schema | 模型输出和外部输入都做运行时检查；TS 类型本身不验证外部 JSON |
| 浏览器和 HTTP | Playwright + Node HTTP 客户端 | 浏览器 trace、页面状态、接口请求响应；同一检查共享明确前置数据 |
| 证据索引 | SQLite | 事务保存消息、要求、运行、证据的关系 |
| 大附件 | 独立文件目录 | 截图、trace、stdout、stderr、响应体，数据库保存引用和内容摘要 |
| 项目运行 | Docker 受限执行环境 | 被测应用、数据和可变依赖不直接写宿主工作目录 |
| 对外调用 | CLI + 官方 MCP TypeScript SDK + 宿主适配器 | 共用 Core；接入协议不拥有最终裁决权 |
| 报告 | 模板生成 Markdown/终端摘要、JSON、本地 HTML | 原话与事实字段直接取记录，必要解释才交给模型 |

Pi 负责调用模型和工具的循环、事件与上下文处理。验收状态、通过条件、预算及证据来源由 VibeGuard 控制。Jev/Laya 不进入必需依赖图。

## 2. 整体数据流

    宿主适配器 / CLI 对话文件 / MCP 材料引用
        → Intake：任务边界、原始材料、完整性检查
        → Requirements：当前有效要求、原话、变更关系
        → Planner：验收条件、检查方法、预算
        → Runner：固定快照，启动被测应用，实际执行
        → EvidenceStore：原始结果与附件
        → VerdictEngine：按证据判定，显式保留缺口
        → Reporter：原话 + 结论 + 证据
        → 原宿主结果入口 / CLI / 本地报告

LLM 用于理解和规划。Runner 执行取证。VerdictEngine 用程序实现可以明确计算的判定。模糊的语义检查若没有足够支持，只能进入解释、补证或无法验证，不能自动包装成客观通过。

## 3. 模块边界

| 模块 | 输入 | 输出 | 禁止承担的职责 |
| --- | --- | --- | --- |
| HostAdapter | 宿主原始事件和消息 | TaskBundle、材料完整性、报告投递能力 | 编造未收到的历史对话 |
| RequirementResolver | 原始消息、已有要求版本 | RequirementRevision、歧义与覆盖记录 | 用摘要替换原话；把 Agent 自述当客户新增要求 |
| Planner | 有效要求、仓库说明、运行配置 | Criterion、CheckSpec、补充风险 | 删除难测要求以获得全绿 |
| JobController | 检查计划与资源预算 | 运行状态、顺序、取消、重试 | 将工具错误改为通过 |
| Runner | 快照与允许的 CheckSpec | ExecutionRecord、Evidence | 接受调用者上传的 exitCode 作为自己的执行结果 |
| VerdictEngine | 条件、执行记录、证据关系 | CheckResult 与有范围的汇总 | 让模型概率直接覆盖缺失证据 |
| EvidenceStore | 受信控制器产生的记录 | 可查询、可导出的历史 | 把数据库文件本身当成防篡改保证 |
| Reporter | 固定运行快照与结果 | 摘要和详细报告 | 重写事实、隐藏失败或未执行项 |

## 4. 核心数据契约

第一版至少定义以下对象。字段名可在 M1 小幅调整，语义不变；外部格式包含 schemaVersion。

### TaskBundle

- taskId、sessionId、host、taskBoundary：明确本次任务及包含的消息范围。
- messages：messageId、序号、role、原始 text、来源、时间（宿主无时间时显式为空）。
- transcriptCoverage：complete / partial / unknown；coveredMessageIds、缺口、获取方式。
- deliveryClaims：干活 Agent 的交付声明引用，属于待核实材料。
- projectRef、executionProfileRef、triggerEventId。
- completenessBasis：说明为什么认为材料完整。MCP 参数中的 complete 不能单独成为完整性证明。

完整性是相对于明确任务边界。宿主转录、用户导入文件、Agent 提供的摘要分别标注来源；仅收到摘要时不能输出完整需求级验收通过。

### ProjectProfile：项目怎么运行

由项目维护者配置启动命令、就绪探测、允许的接口或页面、测试账号的引用、测试数据准备和清理方式、运行隔离与资源边界。登录、优惠券等后续任务可复用这份配置。它只描述**怎样接触和观察项目**，不预写“满 120 减 15”“错误密码返回 401”等本次业务预期；这些预期必须从当前有效要求推导。配置缺项时，相关标准进入无法验证并说明缺什么。

### RequirementRevision

- requirementId、revision、status：active / superseded / cancelled / ambiguous。
- sourceKind：explicit_user / existing_constraint / derived。
- sourceRefs：messageId、start、end、quote；文件约束使用文件快照与位置。
- normalizedRequirement：便于规划的表达，与原话分开存储。
- supersedes、dependsOn、scope、mandatory、ambiguityReason。
- attribution：原话片段属于用户直接要求、引用的第三方内容、Agent 说法还是待确认讨论；adoption：已采纳、拒绝、暂缓或不明。只有来源和采纳关系足够明确的内容才进入当前必需要求。

消息原文按原始 UTF-8 保存；start/end 使用 JavaScript 字符串 UTF-16 索引、起点包含终点不包含。程序必须检查 text.slice(start, end) 与 quote 相等。模型只提出引用位置，最终显示文本由程序提取。

替代只影响对应要求。例如“门槛改为 150，其他不变”保留一次使用和有效期要求。用户引用他人的建议、讨论中的假设不自动变成正式要求。逐字引用校验只能证明文字存在，不能证明用户采纳；真实 Codex 长对话试点已出现把第三方观点误列为已确定要求的案例。

### Criterion 与 CheckSpec

- criterionId、requirementIds、sourceKind、mandatory、scope。
- preconditions、action、expected、comparison/control、coverageLimits。
- checkId、type：command / http / browser / data_query。
- target、inputs、assertions、timeout、所需运行配置、预算和风险。
- planRevision、planHash、生成该计划的模型与提示版本。

Criterion 是**可验收标准**，先描述在什么前置条件下做什么、预期观察到什么，与当前项目的 API 名称分开。CheckSpec 才把标准翻译成实际请求、浏览器操作或命令。例：“一券一次”的标准是同一张测试券首次获得优惠、第二次不能再次获得优惠；执行计划才写如何创建券、连续下单以及读取两笔持久化订单。

计划中的数值与行为预期必须追溯到要求或明确推导；不能从被测应用当前输出倒推“正确答案”。比较运算、金额、时间使用代码和明确单位；金额默认使用整数分。

command 的退出码只判定这条命令的执行结果。测试实际发现数量、跳过情况、断言和覆盖关系也必须保存。不能把 npm test 返回 0 自动扩展为所有需求通过。

### RunManifest 与 Evidence

- runId、attempt、taskId、requirementRevision、scope、触发来源。
- snapshotId：项目快照内容摘要，包含本次交付所需的已跟踪、未提交及允许的未跟踪文件。
- fileManifest、排除列表、baselineRef、依赖锁文件摘要。
- planHash、测试脚本摘要、运行配置摘要、镜像标识、环境和测试数据版本。
- evidenceId、checkId、executionId、采集器类型与版本、时间、命令或操作、退出状态。
- rawArtifactRefs、contentHash、结构化观察值、截断与脱敏说明。
- 模型调用用量、耗时和费用来源；无费用数据标未知，估算值显式标注。

Git commit ID 不能代表未提交内容，必须记录实际快照。证据附件按安全文件名保存，禁止路径穿越。报告中的链接只能读取本次授权记录。

### CheckResult 与 Report

- verdict：VERIFIED / FAILED / UNVERIFIABLE。
- criterionId、checkId、evidenceRefs、expected、observed、reason、limitations。
- currentness：current / stale；这是适用性，不改写历史 verdict。
- report：当前范围、有效要求清单、逐项结果、未覆盖项、补充风险、运行说明。
- gapStage：material / requirement / plan / execution / evidence / currentness；每个无法验证项还需记录缺少的证据及可执行的补证动作。阶段是失败位置，不擅自归责某个模型或个人。

所有对象持久化，建立“原话 → 要求版本 → 条件 → 执行 → 证据 → 结论”的关系。外部调用不能直接写 CheckResult 或 Evidence。

## 5. 需求覆盖与判定规则

1. 对完整任务的全部消息建立处理记录；超长对话可分块，但不能静默丢弃未处理块。需求修改必须能关联前文。
2. 每个当前有效要求至少关联一个验收条件，或明确记录无法设计/执行的原因。存在没有去向的要求时不能总体通过。
3. 同一要求下的必需检查全部满足，才将该要求标为已验证。必需项失败优先于无法验证，无法验证优先于通过。
4. 未运行、前置数据不成立、环境启动失败、超时、预算耗尽、测试被跳过、证据缺失，均不能作为通过依据。
5. 被测应用在正确前置条件下返回 500 可以是失败证据；浏览器未安装或运行器未启动属于无法验证。保留两者区别。
6. 阶段范围之外的要求显示待后续交付。完整任务仍有此类要求时，不显示整个任务已经通过。
7. 必需检查全绿且材料、范围和引用检查通过后，才显示“本次范围内的必需检查已验证”。这不保证需求拆解没有遗漏，报告保留人工审阅入口。
8. 本轮判定绑定计划、代码、要求与环境快照。变化发生时显示旧版本结果；不覆盖旧报告。

报告对同一条要求先显示原话及当前版本，再显示各条标准、对应检查、已得到的证据和缺口。真实试点中，“每张券只能使用一次”已有要求，但**人工演示计划**明确写了“本轮未规划重复用券检查”；它属于 plan 缺口，执行器没有尝试相关步骤，不能称为模型规划失败或执行失败。计划包含该检查却因服务异常没跑完时，才属于 execution 缺口。

首版复验优先重跑当前范围的全部必需检查，复用计划以节省模型调用。精细选择受影响测试属于后续优化，需要证明不会漏回归。

## 6. 执行状态与预算

    RECEIVED → RESOLVING → PLANNING → RUNNING → FINALIZING → FINISHED

异常可以转入 FINALIZING，保存已有证据并生成无法验证项。用户取消记录为 CANCELLED 的执行状态，报告保留已执行结果，其余为无法验证。程序崩溃后可恢复已保存记录，不能凭临时内存恢复一个通过结论。

JobController 管理并行度、总时限、工具时限、模型调用次数和补证次数。超过预算停止新增动作，给出报告。重试产生新 attempt，旧尝试不删除；不能只留下成功的那次来掩盖不稳定性。

同一 taskId + requirementRevision + snapshotId + planHash 的重复事件默认复用正在执行或已结束的运行。明确的“重新验收”可创建新 attempt。

## 7. CLI 与 MCP 的拟实现接口

CLI 建议：

    vibeguard doctor
    vibeguard verify --task <完整任务JSON> --project <目录> --profile <配置>
    vibeguard status <runId>
    vibeguard report <runId> --format json|html|markdown
    vibeguard evidence <evidenceId>

verify 默认前台等待，支持结构化输出。验收 CLI 退出码约定：0 本次必需范围已验证；1 存在必需项失败；2 无法验证/未完整验收；3 参数或内部错误。宿主 hook 的退出码有独立语义，适配器必须转换，不能直接透传并意外阻断宿主。

MCP 第一版只提供三个工具，减少描述与调用开销：

| 工具 | 入参 | 返回 |
| --- | --- | --- |
| verify_task | 已登记的 taskRef、projectRef、profileRef、scope、可选 forceRerun | runId、状态、输入资料缺口 |
| get_verification | runId、可选 includeReport | 状态、逐项摘要、报告引用 |
| read_evidence | evidenceId、有限 offset/limit | 元信息与允许的证据片段，注明截断 |

完整材料由宿主适配器或 CLI 登记。MCP 本身不会自动取得历史消息；不能要求干活模型重新编写一份“完整对话”充当原始来源。工具不得提供 set_verdict、mark_pass 等捷径。

长任务可返回 runId 后查询，但不能假装协议自动推送结果。报告投递通过宿主实际能力实现，轮询设上限。

## 8. 宿主钩子与通用接入

发行形态与安装路径见 [安装和跨平台接入设计](06-installation-and-integration.md)。同一个 Core、CLI、MCP 服务可随一个包分发；每个宿主的钩子事件、对话读取和结果回传仍由小适配器转换成同一个 TaskBundle。一个可安装包不等于所有 Agent 都支持自动验收。

每个适配器声明：能否读取完整任务消息、取得最终回复、获得文件变化、触发收尾、显示报告、允许后台运行。缺哪项就显示哪项缺口。

首个适配宿主在 M0 依据团队实际可用环境选择：需要能取得本任务完整对话、交付事件，并提供可访问的报告入口。Claude Code 的官方资料公开了 Stop 等事件和转录文件字段，可作为候选调查；Codex、Cursor 等宿主也按同一能力表评估。Stop 一类事件表示一轮回复结束，不自动等于任务完成。宿主尚不可用时，先用 CLI 规范化对话导入打通 Core，不宣称自动接入完成。

触发策略：用户启用的开发任务在收尾时，先检查新要求/代码快照和已有验收记录。明确等待用户输入不启动全量运行；状态不明但存在待验收交付时，保守进入待验收/验收流程，不能靠模型一句“不需要”默默跳过。

首次自动接入必须实测完整链路。同步 hook 超时不足时创建后台验收任务，并用平台实际支持的结果入口显示状态；平台做不到自动投递时，明确能力限制，保留 CLI/MCP 报告入口。后台任务退出不能被显示为通过。

避免递归触发：VibeGuard 的报告回传和查询不产生新的开发交付事件；相同快照去重；第一版不用阻断回复来反复要求 Agent 修复。

## 9. 运行与信任边界

需要区分：用户信任的 VibeGuard 控制程序；供理解规划的模型输出；待检查的项目代码与对话材料。后两者都不能控制裁决规则。

- 项目副本、测试数据在受限容器中运行；使用普通用户、资源限制、受限网络，不挂载宿主密钥、整个用户目录或 Docker socket。
- 浏览器/API 验证驱动与被测应用分离。被测应用不可写验证脚本、最终证据目录或裁决程序。
- 模型生成的脚本只在授权执行环境中运行；不授予规划模型任意宿主 shell。工具参数按路径、目标和资源范围校验。
- Runner 自己启动命令、收集退出状态和操作记录。被测应用打印“PASS”只是一段应用输出。
- 依赖安装与访问外网使用单独配置和缓存，不能因为项目要求就默认开放宿主网络、凭据或系统权限。
- 对话、仓库文档、网页与工具输出中的指令当作被分析数据；不得改变 VibeGuard 的来源与判定规则。
- 证据保存在项目工作目录之外。由控制器写入；对外只提供查询。文件摘要用于关联和检测变化，本地 SQLite、哈希与独立进程本身不保证恶意同权限进程无法伪造。
- 宿主上干活 Agent 若拥有同用户任意文件写权限，首版只能声明本地可追溯。要声明强防伪，需要独立账号/受保护服务或远程受信执行与存储，并单独验收。

Docker 提供隔离机制但不是绝对安全承诺。此版本针对受控开发验收，不承诺抵御宿主管理员或所有恶意项目。Git worktree 只是代码副本，不是安全沙箱。

## 10. 控制 token 的实现约定

- 完整原文持久保存；增量处理新消息，末尾检查每条用户消息的处理去向与需求关联。原话引用必须可回查。
- 同一段材料上的相关小问题合并调用；不要每个条件都重发整个会话。
- 原始日志落盘，传给模型结构化结果和必要片段；缺少解释再按证据引用读取。截断必须显式标记。
- 固定事实报告由模板渲染；不要让另一次 LLM 调用重写金额、原话或判定。
- 重用计划和检查脚本；复用判定必须满足完整版本条件，首版优先重跑。
- 缓存键包含输入、模型版本、提示版本与配置。命中缓存必须能追溯，不能把别的任务结果串用。
- 默认 1 个验收模型，不进行模型投票。每次模型调用记录用途、用量和失败补救成本。
- Jev/Laya 先以旁路模式给建议，既不删除要求也不单独跳过必需检查；通过对照实验后再启用有限替代。

## 11. 官方资料与核查时间

以下资料于 2026-09-27 查询，用于说明选型依据，不代表相关集成已经运行验证。开发前核查版本，避免复制过期包名或接口。

- [Node.js 发布状态](https://nodejs.org/en/about/previous-releases)
- [Pi Agent Core](https://github.com/earendil-works/pi/tree/main/packages/agent)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Zod](https://zod.dev/)
- [Playwright](https://playwright.dev/docs/library)
- [SQLite 适用场景](https://www.sqlite.org/whentouse.html)
- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)
- [Docker 安全说明](https://docs.docker.com/engine/security/)
- [Jev 价格与模型信息](https://docs.typesafe.ai/models)、[能力边界](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- [Laya](https://github.com/NandhaKishorM/laya)
