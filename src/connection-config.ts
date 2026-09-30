import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verificationToolName, type SupportedCollector } from "./capture-hook.js";

export interface ConnectionOptions { installDir?: string; dataDir?: string; nodeBin?: string; codexBin?: string; platform?: NodeJS.Platform }

function shellArgument(value: string, platform: NodeJS.Platform): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Configuration path contains control characters");
  if (platform !== "win32") return "'" + value.replaceAll("'", "'\"'\"'") + "'";
  // Shared Windows-safe quoting for the cmd/PowerShell command field, not JSON escaping.
  if (/["%`$&|<>;!]/.test(value)) throw new Error("Hook command path contains shell-special characters; choose a plain installation path");
  return "'" + value.replaceAll("\\", "/").replaceAll("'", "''") + "'";
}

/** Emits reviewable configuration only; never writes an Agent's configuration. */
export function buildConnectionConfig(host: SupportedCollector, options: ConnectionOptions = {}): Record<string, any> {
  const installDir = resolve(options.installDir ?? fileURLToPath(new URL("../", import.meta.url)));
  const dataDir = resolve(options.dataDir ?? join(installDir, ".vibeguard"));
  const command = options.nodeBin ?? process.execPath;
  const args = [join(installDir, "dist", "mcp-entry.js"), "--data-dir", dataDir];
  const hookArgs = [join(installDir, "dist", "capture-hook-entry.js"), "--host", host, "--data-dir", dataDir];
  if (options.codexBin) {
    if (host !== "codex") throw new Error("--codex-bin only applies to Codex");
    hookArgs.push("--codex-bin", options.codexBin);
  }
  const platform = options.platform ?? process.platform;
  const invocation = [command, ...hookArgs].map(value => shellArgument(value, platform)).join(" ");
  const hookCommand = platform === "win32" ? `powershell.exe -NoProfile -NonInteractive -Command "& ${invocation}"` : invocation;
  const mcpEntry = { command, args, ...(host === "claude-code" ? { env: { DEEPSEEK_API_KEY: "${DEEPSEEK_API_KEY}" } } : {}) };
  return {
    schemaVersion: 1, host, mode: "manual", writesHostConfig: false,
    mcp: {
      form: { name: "vibeguard", type: "STDIO", command, args, workingDirectory: installDir, forwardEnvironmentVariables: ["DEEPSEEK_API_KEY"] },
      json: { mcpServers: { vibeguard: mcpEntry } },
      ...(host === "codex" ? { toml: ["[mcp_servers.vibeguard]", `command = ${JSON.stringify(command)}`, `args = ${JSON.stringify(args)}`, 'env_vars = ["DEEPSEEK_API_KEY"]'].join("\n") } : {}),
    },
    collector: {
      bundled: true, hookConfigTarget: host === "codex" ? "~/.codex/hooks.json" : "~/.claude/settings.json",
      hooksJson: { hooks: { PreToolUse: [{ matcher: `^${verificationToolName}$`, hooks: [{ type: "command", command: hookCommand, timeout: 60 }] }] } },
      requiresHostTrust: host === "codex",
      approvalEffect: host === "codex" ? "Codex 的 updatedInput 要求 allow；此 Hook 成功采集后允许该次 verify_task 调用，不改变全局审批或其他工具。" : "只补入 taskRef，不返回 allow；工具审批仍由 Claude Code 处理。",
    },
    diagnostics: { expectedTools: ["verify_task", "get_verification", "read_evidence"], transcriptCheck: "用户主动调用 verify_task 后，应生成当前 sessionId 的 host-snapshots 收据；仅看到工具列表不能证明聊天采集成功。", automaticVerification: false, taskScopeConfirmed: false, externalProjectExecution: false },
  };
}
