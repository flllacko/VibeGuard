import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { prepareVerificationHook, type SupportedCollector } from "./capture-hook.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!["--host", "--data-dir", "--codex-bin"].includes(flag) || !value || value.startsWith("--")) throw new Error("Invalid capture Hook startup option");
    if (options.has(flag)) throw new Error("Duplicate capture Hook startup option");
    options.set(flag, value);
  }
  const host = options.get("--host");
  if (host !== "codex" && host !== "claude-code") throw new Error("Capture Hook requires a supported --host");
  if (options.has("--codex-bin") && host !== "codex") throw new Error("--codex-bin is only supported by the Codex collector");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) throw new Error("Hook input exceeds limit");
    chunks.push(bytes);
  }
  const result = await prepareVerificationHook(Buffer.concat(chunks).toString("utf8"), {
    host: host as SupportedCollector,
    dataDir: resolve(options.get("--data-dir") ?? fileURLToPath(new URL("../.vibeguard/", import.meta.url))),
    codexBin: options.get("--codex-bin"),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "VibeGuard 采集程序未能启动；请检查 Hook 的启动命令与参数。" } }) + "\n");
});
