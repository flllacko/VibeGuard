# Docker 项目运行与记录（D2 运行底座）

日期：2026-10-19。Core/CLI 已实现并做真实 Docker 实测；外部项目的动态功能验收与桌面安装包仍待完成。

## 用户得到什么

VibeGuard 可以把 D1 保存的项目副本放进受限容器，启动服务、实际请求就绪接口，记录退出、超时、取消与清理结果。不会修改原项目，不会在 Docker 不可用时转到宿主直接执行。

**服务能访问，仅表示具备继续检查的条件。** 此报告的任务结论固定为 `UNVERIFIABLE`（无法验证），不能拿 HTTP 200 或启动命令成功代替需求验收。

## 当前支持范围

- Linux Docker Engine；本机已缓存官方 `node:24-bookworm-slim` 镜像。
- 项目入口为 `node` 加副本中的 `.js`、`.mjs` 或 `.cjs` 文件。可以使用 Node 内置模块及副本中的本地代码。
- 不安装依赖、不执行项目 Dockerfile、不提供外网、宿主端口或外部数据库。`node_modules` 默认不进入副本，因此依赖未打包的普通 npm 项目暂不能直接运行。
- 运行时源码只读，临时文件可以写 `/tmp`。默认 256 MiB 内存、1 CPU、64 个进程限制；就绪超时使用项目配置。
- 当前通过显式 Core/CLI 入口执行。MCP 的外部项目查询仍报告准备状态；尚未将此次运行自动接到原聊天的功能验收。

这是一项有明确支持范围的运行能力，不代表任意仓库开箱即验。

## 开发者怎样调用

先完成[外部项目准备](18-external-project-preparation.md)，取得同一数据目录中的 `PROJECT_REF`。首次使用需主动下载基础镜像；运行器不会自动下载。

```powershell
docker pull node:24-bookworm-slim
node dist/cli.js project-runtime PROJECT_REF --data-dir D:/VibeGuardData
node dist/cli.js runtime-report RUN_ID --data-dir D:/VibeGuardData
```

`project-runtime` 会执行项目代码，并在结束前清理本次资源。Ctrl+C 请求取消，程序仍尝试完成清理。退出码 0 表示运行检查就绪且清理完成；2 表示运行检查未成功。两者都不是用户任务验收结论。`runtime-report` 只读已有记录，无需 Docker 或模型。

桌面版后续负责传递这些编号和展示进度，普通用户无需逐次输入容器命令。

## 真实执行顺序

1. 重新核对已确认要求、项目配置与交付副本的关联及内容摘要。
2. 检查 Docker 与本地镜像，记录基础镜像的固定 ID。
3. 使用 `tar-stream` 仅打包清单内的文件与目录，再次校验内容；部署时设置只读权限。
4. 创建未启动的准备容器，复制文件，保存为本次临时镜像。准备容器不运行项目。
5. 从临时镜像 ID 创建只读验收容器，核对隔离设置后才启动。
6. 在容器内部用固定探测程序发出真实 HTTP 请求，记录状态码、受限响应、进程状态及日志。
7. 按本次运行标签核对身份，清理准备容器、验收容器、临时镜像并复查。身份不匹配不删除；未确认清理成功必须显示缺口。
8. 写入结构化报告与摘要清单，后续新进程可独立读回。

容器使用非管理员用户，关闭外网、额外权限与提权；不挂载宿主目录、证据库、密钥或 Docker socket，不转发宿主环境变量。实际参数和检查返回都保存在报告中。基础镜像保留作缓存。

## 记录保存在哪里

```text
DATA_DIR/project-runtime/RUN_ID/
  source.tar      本次部署归档
  report.json     固定交付、命令参数、输出、退出状态、就绪观察、清理结果
  manifest.json   报告内容摘要
```

报告绑定 `projectRef`、项目记录摘要、代码副本摘要、配置摘要和镜像 ID。原工作区后来变化不属于这份报告，需重新准备。原始日志可能含被测项目输出的内容，分享前应检查。

本地摘要用于发现内容不一致，不能证明同权限进程无法改写报告与摘要。容器内探测也不能宣称抵御任意恶意进程干扰的独立可信观察。

## 本次验证

128 项本地回归全部通过，其中新增 7 项运行器测试。单元测试使用模拟 Docker，不能代替下面的真实执行。

真实 Docker 测试使用合成对话、合成确认和本地小程序，不调用模型，不冒充真人确认或外部业务验收：

| 情况 | 实际观察 | 结果 |
| --- | --- | --- |
| 正常启动 | HTTP 200；用户 ID 1000；测试 `.env` 未进入副本；源码不可写；只有 loopback 网络 | ready |
| 启动后报错退出 | 真实退出码 7，保存错误日志 | unavailable |
| 服务一直未就绪 | 实际收到 HTTP 503，超过就绪期限 | unavailable |
| 启动后取消 | 实际启动成功后取消，继续独立清理 | cancelled |

四项均清理完成，结论均为 `UNVERIFIABLE`。新 CLI 进程成功读回正常启动记录；再次查询 Docker，没有本工具的容器或临时镜像残留。

本地记录：`.vibeguard/evaluations/docker-runtime-20261019-validated/summary.json`。正常运行编号：`1a626af4-8642-4c9b-be6e-3eecbde42d48`。此目录被 Git 忽略，不随源码提交。

开发期间的失败也保留：首次复制到只读容器被拒绝；随后调整为未启动的准备容器。第二轮遇到 commit 输出混入提示，修复为独立 inspect 镜像身份，并按记录核对、回收该轮遗留镜像，补存 `docker-runtime-20261019-retest/cleanup-adjudication.json`。第三轮日志驱动配置不兼容，改为支持的两个轮转文件。早期失败记录不能充当成功启动证据。

复现入口（创建新的输出目录，确实运行 Docker）：

```powershell
pnpm build
pnpm eval:runtime --run-live --out D:/VibeGuardEvaluations/new-runtime-run
```

## 尚未完成

下一阶段把“已确认要求 → 验收标准 → 执行计划 → 实际功能观察 → 逐项证据与三态结论”接入外部运行器。还需依赖准备、浏览器取证、受控数据库、第二宿主实测和桌面交付。

当前结束即清理容器，不提供长期在线服务。程序被强制结束或机器断电时，无法保证 finally 执行；持久化运行中状态和恢复清理尚待实现。Docker 降低影响范围，不是绝对安全保证。

实现依据：[Docker create](https://docs.docker.com/reference/cli/docker/container/create/)、[文件复制](https://docs.docker.com/reference/cli/docker/container/cp/)、[无网络模式](https://docs.docker.com/engine/network/drivers/none/)、[资源限制](https://docs.docker.com/engine/containers/resource_constraints/)。归档依赖及许可见 [第三方声明](../THIRD_PARTY_NOTICES.md)。
