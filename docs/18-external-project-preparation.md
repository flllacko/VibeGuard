# 外部项目准备：已确认要求与交付副本

日期：2026-10-18。本文记录 D1 的准备链路。2026-10-19 已另增 [D2 Docker 运行底座](19-docker-runtime.md)，通过显式命令执行；本文的准备命令仍不启动项目。外部项目动态功能验收与桌面界面尚未实现。

## 已经能做什么

登记真实项目目录，保存文件内容与结构的副本，将其与已确认的要求版本、当前性核对的宿主采集记录关联。CLI 与 MCP 共用 `external_project` 类型；准备成功仍为 `UNVERIFIABLE / execution`，不生成伪造执行证据。

项目配置只描述怎样运行项目；任务要求、业务预期和 verdict 不能塞进配置。当前准备入口不执行启动命令、安装依赖、读取其他聊天或调用模型。

## 开发入口

先通过既有要求审查流程取得确认版 `REVIEW_REF` 和对应的独立当前采集 `FRESH_TASK_REF`。不能把待确认清单、历史导出或新用户改口后的旧确认直接用于准备。以下参数不会代替真人确认。

`project.json` 示例（路径按本机填写）：

```json
{
  "schemaVersion": 1,
  "projectId": "my-web-project",
  "description": "待验收的本地 Web 项目",
  "projectRoot": "D:/Projects/my-web-project",
  "excludePaths": ["coverage", "dist"],
  "runtime": {
    "kind": "docker",
    "image": "node:24-bookworm-slim",
    "command": ["node", "server.mjs"],
    "containerPort": 3000,
    "readiness": { "path": "/health", "expectedStatus": 200 }
  }
}
```

准备时仅保存命令及镜像；显式运行需另用 D2 入口。不在配置里填真实密钥；环境凭据引用和依赖安装尚未实现，D2 使用固定资源限制。

```powershell
node dist/cli.js project-prepare --profile project.json --review REVIEW_REF --current-task FRESH_TASK_REF
node dist/cli.js project-inspect PROJECT_REF
node dist/cli.js verify-task TASK_REF
```

用输出的 `projectRef` / `taskRef` 替换占位符。所有命令支持 `--data-dir PATH`，证据数据目录和待验项目目录不可互相包含。桌面界面后续负责选择和传递这些编号。

## 副本与证据边界

- 要求校验成功后才准备文件；复制后再次核对要求版本。
- 按实际磁盘内容复制，包含未提交文件；不调用 Git，不运行 Git hook。
- 默认跳过 `.git`、`node_modules`、`.vibeguard`，以及 `.env` / `.env.*`、常见私钥文件名。其他排除项由 `excludePaths` 指定；每个跳过的入口及原因保留，不能称完整复刻所有环境。文件名规则不保证发现所有敏感内容。
- 拒绝目录链接、符号链接、特殊文件、越界路径和跨平台名称歧义；限制条目、文件大小、总大小及深度。
- 复制时、复制后复读校验已纳入文件，变化时拒绝发布完整 manifest。失败目录可能保留部分文件，但没有完整 manifest，不能登记为可用交付。
- 读取副本会重算每个文件摘要及目录清单，拒绝篡改内容、额外文件、损坏清单或配置替换。
- 后续工作区修改不属于已保存副本，需要重新准备。报告明确绑定固定交付及采集时点，不推断“当前最新”。
- 本地副本不还原 Git 历史、所有权限位或外部数据库状态，也不是 Docker 沙箱。本地哈希不能防止同权限进程同时改写副本和记录。

## 本次验证

本地测试使用明确标注的合成宿主原文与确认，调用实际 Core、CLI 和独立 stdio MCP。覆盖配置越权字段、目录重叠、排除项、稳定内容摘要、副本独立性、篡改/额外文件拒绝、目录链接、复制限制、旧确认与新改口拒绝、准备状态和跨进程读取。

这轮 D1 测试不使用真实模型，不把合成确认当真人实测；未执行任何被测项目。当时 Docker 只读探测未找到 Linux Engine 管道。后续已启动 Docker 并完成 D2 容器实测，见新文档；确认要求接入外部动态功能检查仍待 D3。
