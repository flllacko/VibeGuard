# VibeGuard 安装与跨平台接入设计

更新：2026-09-30。**以下主要是目标方案，不是已发布的安装说明。**当前仓库 `package.json` 仍为 `private`，已有 CLI 与本地 stdio MCP 原型，具体可执行步骤见 [主动验收与 MCP 使用说明](07-mcp-prototype.md)。Codex 已完成官方接口读取本条真实历史、CLI 登记和 MCP 客户端自动采集的[试点](08-codex-history-pilot.md)，尚未在原聊天工具目录中注册或自动绑定任意新会话。没有全局安装包、可安装的宿主 Hook 配置或“连接宿主”命令。另有一个仅处理 Trae Hook JSON 的本地收集原型，详见根目录 README；它尚未在 Trae 应用内触发。

## 用户实际要做的两件事

**安装 VibeGuard**：把独立验收程序放到用户机器或受控服务中，负责整理要求、运行检查和保存证据。第一版计划用跨 Windows/macOS/Linux 的 Node.js 包分发 Core、CLI 与 MCP 服务；未来可另外包装成独立安装器。包名和命令尚未发布。

**接入某个 Agent**：让那个 Agent 知道怎样调用 VibeGuard，以及在什么时点调用。这可能是宿主内的 MCP 配置、Hook 配置、插件/连接器，或者用户手动导出对话再用 CLI 导入。**下载一个包不等于所有 Agent 自动接入**；各家插件格式不同，不存在一份通用插件文件可在所有平台直接安装。宿主插件可以包装配置和入口，但真正裁决仍由独立的 VibeGuard 进程完成。

通俗地说，MCP 是给 Agent 一个“可以调用验收”的工具；Hook 是宿主在固定节点执行程序；插件/连接器是把这些入口打包给该宿主安装的方式。MCP 自身不保证会被调用，Hook 的 `Stop` 也只代表一次回复准备结束。自动验收还需要可靠的交付判断、完整任务对话和报告回传。

确认的默认体验是：安装 VibeGuard → 在所用 Agent 中完成一次接入 → 用户照常聊天与改需求 → Agent 交付后，用户说“用 VibeGuard 验收” → Agent 调用独立验收程序 → 用户在原聊天或报告链接中看到“原话、当前要求、验收标准、实际证据、结论”。长任务可主动发起阶段验收与最终验收。自动验收是后续可开启的模式，默认关闭；只有用户启用后才按宿主事件检查新交付。如果宿主不提供完整对话，就不能宣称完成需求级验收。

例如在未来已适配的 Qoder 中：用户先安装 VibeGuard 并完成 MCP 或插件接入；用户说“满 150 元优惠 20 元，每张券只能用一次”，后来又补充“149 元不优惠”；Qoder 改完代码后，用户说“用 VibeGuard 验收”，采集器登记原始会话与代码快照，Agent 调用 `verify_task`。VibeGuard 在独立进程里整理当前要求、生成验收标准、运行 150 元与 149 元对照及同券两次使用检查，保存请求与订单证据，再把报告引用交回 Qoder。后续用户若开启自动模式，Hook 才在收尾节点按程序规则触发相同流程。这个宿主链路是**目标效果**，目前没有实现，也不能只凭 Qoder 提供 Hook 就断言报告一定能自动显示在原聊天。

## 接入能力分级

| 宿主能力 | 用户可得到的体验 | 必要条件 |
| --- | --- | --- |
| 钩子/事件 + 完整对话读取 + 报告回传 | 主动验收；用户开启自动模式后可在交付时启动验收，结果回到原聊天或其报告入口 | 为该宿主实现并实测适配器；收尾事件还须判断是否真有交付 |
| MCP 工具调用，缺少可靠的收尾钩子 | 用户或 Agent 主动调用 `verify_task`、查询报告 | 已登记可信对话材料；MCP 自身不会自动取得历史消息 |
| 可运行命令并能导出对话 | CLI 导入对话后手动验收 | 对话来源、任务边界和完整性明确；缺消息则标无法验证 |
| 以上均不可用 | 不能承诺在该 Agent 内自动接入 | 只能使用宿主提供的导出或等待其开放接口 |

因此“任意 Agent 都能一键自动验收”不是可诚实承诺的目标。可以承诺的是：**同一个验收核心、同一份任务数据格式、可增加新的宿主适配器**；每个平台的自动化等级在支持矩阵中公开。

## 计划中的安装和连接流程

下列命令是**拟实现的产品体验，请勿当作现有命令执行**。`<正式包名>` 表示发布后确认的包名：

```text
npm install -g <正式包名>
vibeguard doctor
vibeguard connect <宿主名>    # 仅对已实现的宿主；安装前展示将修改的配置
vibeguard doctor codex
vibeguard disconnect codex    # 只删除 VibeGuard 自己的配置
```

`connect` 是计划中的配置助手，不是所有宿主都必然有同一种接入命令。有的宿主适合导入专用插件或连接器，有的允许程序写入 MCP/Hook 配置。它应检查版本及可用能力、展示修改清单、备份原配置、只增加自己的条目，并通过一次无业务副作用的诊断事件确认能收到对话和报告。重复执行应幂等；卸载不能覆盖用户原有的其他配置。修改全局配置需由安装者确认，不能由干活 Agent 悄悄完成。

项目再提供一份可复用的 `ProjectProfile`：启动方式、就绪探测、允许的接口或页面、测试账号引用、数据准备与清理、资源和网络边界。它告诉 VibeGuard **如何检查这个项目**；“满 120 减 15”等本次要检查的业务标准仍从任务对话生成。未知项目没有配置时，相关动态检查标无法验证，不自动在用户机器上猜测启动命令。

## 各宿主怎样接入

每个适配器负责三件事：取得原始对话并声明完整性；识别交付候选及代码快照；把报告摘要或引用送回宿主。它只转换材料和事件，不单独裁决通过。`Stop`/`stop` 表示一轮响应结束，不能单凭这个事件判断任务完成。

下表是**官方文档能力调查**，不是 VibeGuard 已支持名单。产品版本、CLI、IDE、企业版可能提供不同入口，实装前必须分别测试。`完整对话` 还包括消息来源、历史改口和时间顺序，不能仅凭 Hook 的最后一句回复推定。

| 宿主 | 官方文档可确认的入口 | 计划接入与待验证事项 |
| --- | --- | --- |
| Codex | 优先调查文档化的会话读取/轮次事件；钩子可在 `UserPromptSubmit`、`Stop` 调用适配器。用户级配置可放在 `~/.codex/hooks.json`，MCP 在 Codex 配置中登记。见[钩子](https://learn.chatgpt.com/docs/hooks)、[App Server](https://learn.chatgpt.com/docs/app-server)、[MCP](https://learn.chatgpt.com/docs/extend/mcp)。 | 钩子给出的 `transcript_path` 可为空，文件格式不保证稳定；需验证当前桌面/CLI 版本能否读取完整任务和把结果显示在同一聊天。 |
| Claude Code | `UserPromptSubmit` 保存用户输入，`Stop` 触发候选验收；用户或项目的 `settings.json` 可配置钩子，MCP 可通过其命令或项目配置登记。见[钩子](https://code.claude.com/docs/en/hooks)、[MCP](https://code.claude.com/docs/en/mcp)。 | 转录文件、远程会话及结果回传能力需在目标安装方式下测试；不能把最终一句话当完整需求。 |
| Cursor | `beforeSubmitPrompt`/`stop` 等钩子；用户级 `~/.cursor/hooks.json` 或项目级 `.cursor/hooks.json`，MCP 可放在 `.cursor/mcp.json`。见[钩子](https://prod.cursor.com/docs/hooks)、[MCP](https://prod.cursor.com/help/customization/mcp)。 | `CURSOR_TRANSCRIPT_PATH` 只在启用转录时出现；没有完整记录则降级为材料不完整。 |
| Qoder CN IDE | 官方[Hook 文档](https://docs.qoder.cn/user-guide/hooks)列出 `UserPromptSubmit`、`Stop` 和 `transcript_path`；[插件文档](https://docs.qoder.cn/qoder-plugins)允许把 Hook 与 MCP 放在一个宿主插件中。 | 可做专用插件来安装入口，并让独立进程读取会话；仍需实测转录的完整性、任务边界、自动触发和报告回传。Qoder CLI 与其他版本单独验证。 |
| 腾讯 WorkBuddy | 官方[用户文档](https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)提供 MCP 配置；[开放平台连接器](https://open.workbuddy.cn/docs/connector)有 `MCP + Skill` 和 `CLI + Skill` 两种包装。 | 可先提供主动调用的 MCP/连接器入口。当前资料不足以证明普通 WorkBuddy 能在任务完成时自动触发、向外部服务提供完整聊天或把报告写回原聊天；这三项先记为待验证。WorkBuddy 与其企业/CodeBuddy 产品不能混为一谈。 |
| 豆包（主对话产品） | [豆包官方说明](https://www.doubao.com/legal/terms)覆盖网页、应用、插件等多种产品形态；本轮尚未确认主对话产品是否向第三方开放可用的任务结束事件、完整对话读取或 MCP 接入。 | 豆包与 ZCode 分别调查。第一阶段先确认用户实际使用的豆包产品与版本，以及能否导出可信对话；没有可验证的宿主入口时，只能评估导入方式，不能承诺自动验收。豆包工作等其他形态单独核查。 |
| ZCode（Z.ai/GLM） | 官方[插件](https://zcode.z.ai/cn/docs/plugin)可包含 MCP 与 Hook；[Hook 文档](https://zcode.z.ai/cn/docs/hooks)列出 `UserPromptSubmit`、`Stop` 和临时 `transcript_path`。 | 可评估专用插件，在 Hook 活跃期间复制必要会话材料并调用独立进程；须实测完整性、清理时机及回传。官方[产品介绍](https://zcode.z.ai/cn/docs/welcome)称其为 GLM/Z.ai 的 ZCode，与豆包分列。 |
| TraeCode（TRAE） | 官方[Hook 文档](https://docs.trae.cn/ide_automate-actions-with-hooks)列出 `UserPromptSubmit`、`Stop` 等事件；[MCP 文档](https://docs.trae.cn/ide_use-mcp-servers-in-agents)说明内置与自定义 Agent 可用 MCP。 | 可评估 Hook 加 MCP；已公开的[Hook 输入字段](https://docs.trae.cn/ide_hook-configuration-reference)示例提供本轮 `prompt`、`last_assistant_message`，未在该文档找到完整转录路径。需要实测能否从首轮持续收集完整聊天及回传；TraeWork 等其他产品另查。 |

主流平台候选池还包括 GitHub Copilot、Gemini CLI、Windsurf、OpenCode、Cline、Aider、扣子等。列入候选池只表示未来按同一能力表调查，**不是已适配或承诺全部自动接入**。第一阶段优先挑能实测取得完整对话、交付时点和报告回传的一个宿主，随后在第二个宿主复用 Core。

其他 Agent 按同一能力表新增适配器，不需要复制 Core。只有 MCP 的平台先提供主动验收，不宣传自动收尾；有钩子却拿不到完整对话的平台可以逐轮收集用户输入与 Agent 输出，或在用户授权下导入完整记录。仍缺材料时，应写明缺失范围并标无法验证。

## 接入完成的验收方式

至少在两个不同宿主上，用**同一套 Core**演示：用户提出需求并改口 → Agent 交付 → 用户主动要求验收 → 宿主适配器传入原话和代码快照 → VibeGuard 独立执行 → 同一原话、标准和证据格式返回。主动模式还要测试宿主不提供完整对话、重复请求与配置卸载恢复。自动模式另测默认关闭、明确启用、普通问答、等待用户补充、重复 `Stop` 与报告回传触发递归。首个宿主通过只能宣称“支持该宿主”；第二个宿主的实测才支持跨平台复用主张。
