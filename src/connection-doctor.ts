import { access } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { prepareConnection, type InstallOptions } from "./connection-install.js";
import type { SupportedCollector } from "./capture-hook.js";
import { CONNECTION_RESOURCE, ConnectionInfoSchema, inspectConnectionTools } from "./connection-protocol.js";

export interface ConnectionCheck { name: string; status: "passed" | "failed" | "pending"; detail: string }
/** Runs only our known bundled server, never arbitrary commands copied from host config. */
export async function checkConnection(host: SupportedCollector, options: InstallOptions = {}) {
  const checks: ConnectionCheck[] = [];
  let plan;
  try {
    plan = await prepareConnection(host, options);
    checks.push({ name: "配置", status: plan.edits.length ? "pending" : "passed", detail: plan.edits.length ? "尚需安装或更新 VibeGuard 的连接配置" : "用户配置中的 MCP 和采集命令与当前向导一致；不代表宿主已加载" });
  } catch {
    checks.push({ name: "配置", status: "failed", detail: "现有配置格式、路径或旧采集器有冲突，请先运行 connect 预览具体原因" });
  }
  const installDir = plan?.guide.mcp.form.workingDirectory ?? options.installDir;
  if (installDir) {
    let client: Client | undefined;
    try {
      await access(join(installDir, "dist", "capture-hook-entry.js"));
      client = new Client({ name: "vibeguard-connection-doctor", version: "0.0.1" });
      const transport = new StdioClientTransport({ command: process.execPath, args: [join(installDir, "dist", "mcp-entry.js"), "--data-dir", plan?.guide.mcp.form.args.at(-1) ?? options.dataDir!], env: {}, stderr: "pipe" });
      const timeout = setTimeout(() => { void client?.close(); }, 10000);
      try {
        await client.connect(transport);
        const tools = (await client.listTools({}, { timeout: 5000 })).tools;
        const protocol = inspectConnectionTools(tools);
        checks.push({ name: "工具连接", status: tools.length ? "passed" : "failed", detail: "独立客户端连接本包并读取工具列表；不代表平台中已加载的连接" });
        if (!protocol.compatible) checks.push({ name: "外部验收接口", status: "failed", detail: protocol.issues.join("；") + "。请构建本包后重试，不能仅凭三个工具同名判定兼容" });
        else {
          try {
            const resource = await client.readResource({ uri: CONNECTION_RESOURCE }, { timeout: 5000 });
            if (resource.contents.length !== 1 || !("text" in resource.contents[0]!)) throw new Error("Invalid connection resource");
            const info = ConnectionInfoSchema.parse(JSON.parse(resource.contents[0]!.text as string));
            checks.push({ name: "外部验收接口", status: "passed", detail: `本包新进程参数及只读版本标记匹配：${info.protocolRevision}；未执行验收` });
          } catch {
            checks.push({ name: "外部验收接口", status: "failed", detail: "本包版本资源缺失、不可读或不兼容；请构建后重试" });
          }
        }
      } finally { clearTimeout(timeout); }
    } catch {
      checks.push({ name: "工具连接", status: "failed", detail: "未能连接本包的 MCP；请确认已构建、路径可访问，且 Node 版本满足要求" });
    } finally { await client?.close(); }
  } else checks.push({ name: "工具连接", status: "pending", detail: "先修复配置，再执行独立连接检查" });
  checks.push({ name: "平台实际加载版本", status: "pending", detail: `上述只检查新启动的本包；重载平台 MCP 后，在平台中核对 verify_task 的 externalPlanRef/captureTicket 和只读资源 ${CONNECTION_RESOURCE}。不要为了检查版本调用验收或上传历史` });
  checks.push({ name: "模型凭据", status: process.env.DEEPSEEK_API_KEY ? "passed" : "pending", detail: process.env.DEEPSEEK_API_KEY ? "当前进程能读取环境变量；没有请求 API，未验证密钥有效性或宿主转发" : "当前进程没有 DEEPSEEK_API_KEY，请配置环境变量后重新打开平台" });
  checks.push({ name: "当前对话采集", status: "pending", detail: "需要回到平台重载、完成必要信任，再在测试聊天主动验收；核对实际收据的会话身份与原话，换聊天再试一次" });
  checks.push({ name: "项目读取", status: "pending", detail: "尚未选择本次项目及授权读取位置；添加 MCP 不代表获得项目文件权限" });
  checks.push({ name: "证据保存与读回", status: "pending", detail: "接入自检不执行真实任务；实际验收后须读取该运行的证据，不能用工具列表代替证据检查" });
  return { host, status: checks.some(check => check.status === "failed") ? "needs_fix" : "needs_host_check", automaticVerification: false, checks };
}
