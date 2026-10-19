# 外部项目：由确认要求生成验收计划

日期：2026-10-19。本文记录 D3 的第一步。2026-10-20 已接通冻结计划的容器内 HTTP 执行并完成三态及重启读回实测，见 [D3 执行说明](22-d3-http-execution.md)。

## 解决什么

把 D1 绑定的确认要求送入通用 HTTP 规划器。采用审查后的版本而非最早的模型提取结果，保留原话与改口来源，输出“要求 → 标准 → 检查步骤”。不得因为该项目曾有演示脚本，就固定每个新任务的检查内容。

## 数据流

1. `readExternalProject` 复核 D1 的要求版本、采集时点、运行配置与固定文件副本。
2. 将确认后的有效条目投影为规划输入；不覆盖原始整理记录，不重新调用模型猜测哪些改口生效。
3. API 配置只描述接口契约、数据结构与测试数据隔离规则；本次预期来自要求。未知的接口信息应产生缺口。
4. 模型提出标准与步骤，代码复核要求 ID、覆盖去向、检查类型、授权路由、状态契约和数据隔离。模型不能填 verdict 或执行结果。
5. 发布前再次核对绑定；保存独立的外部计划记录，关联要求、文件副本、运行配置与 API 描述摘要。
6. 读回时重新校验记录与来源，再展示可读清单。没有实际运行证据，任务仍为无法验证。

这里的“当前”仅指已经核对的固定采集时点，不证明此后宿主没有新消息。新要求/改口须重新采集、审查并准备新交付；本入口不会监控未采集的聊天。

## 开发入口

先使用 D1 的 `project-prepare` 得到 `PROJECT_REF`，API 描述格式沿用 `ApiProfileSchema`。以下均支持 `--data-dir PATH`：

```powershell
# 只看将发送给规划模型的数据；不联网、不运行项目
node dist/cli.js project-plan-input PROJECT_REF --api-profile api.json

# 调用默认 DeepSeek Flash，仅发送上面预览的 modelInput
node dist/cli.js project-plan PROJECT_REF --api-profile api.json

# 后续读回，无需模型或 Docker
node dist/cli.js project-plan-record PLAN_REF
node dist/cli.js project-plan-record PLAN_REF --format json
```

预览和实际请求共用 `planModelInput`，避免两份格式漂移。不发送完整聊天、项目目录、源码或宿主凭据；被选入的原话/API 描述本身仍可能含敏感内容，调用前应按现有数据外发授权处理。`--provider` / `--model` 仅在更换默认选择时填写。

最小 API 描述形状：

```json
{
  "schemaVersion": 1,
  "profileId": "my-api",
  "description": "测试环境接口契约",
  "routes": [{
    "method": "GET",
    "pathTemplate": "/status",
    "description": "读取运行状态",
    "successStatus": 200,
    "responseExample": { "ready": true }
  }],
  "isolationRules": []
}
```

该例仅展示格式，不表示所有任务都应检查 `/status`，也不是本轮功能验收脚本。自动发现接口和用户一次确认的配置体验尚待接入。目前不支持请求头认证、浏览器步骤、数据库步骤或任意命令。

## 产物与状态

`DATA_DIR/external-plans/PLAN_REF.json` 保存冻结计划、接口描述、版本绑定及模型用量。清单逐条显示原话、标准、前置条件、操作路径与缺口；结构化步骤保存在同一记录中。

覆盖账目分别列完整计划、部分计划、无法计划的条数。它不是执行覆盖率，更不是模型置信度；即使所有要求都有计划，输出仍为 `planned_not_executed / UNVERIFIABLE`，执行证据为空。

本地哈希只能帮助检测内容不一致，不能防止同权限进程重写整套记录。只读旧记录不调用模型；当前重复执行生成命令仍会产生新的模型调用，跨生成缓存尚未实现。

## 验证与下一步

新增 6 项测试，完整构建及 134 项回归通过：用户修订覆盖旧提取、计划漏项/编造项拒绝、路由和操作边界、缺口保留、记录/副本变动拒绝、生成期间交付变化、独立 CLI 进程读回。

测试使用合成消息、确认与规划器替身；没有真实模型调用，不能据此声称新入口的真实规划质量已验证。没有读取新聊天或修改宿主配置。

这一步之后已实现同一冻结计划在 D2 容器生命周期内实际执行、逐步保存观察，见新文档。原 MCP 的自动衔接未在本轮改动；就绪报告仍不能单独代表功能检查通过。
