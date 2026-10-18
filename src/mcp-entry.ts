import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createVibeGuardMcp } from "./mcp-server.js";
import { VerificationService } from "./verification-service.js";
import { PiRequirementGateway } from "./pi-gateway.js";
import { selectModel } from "./model-selection.js";
import { captureCodexTask } from "./codex-history.js";
import { RefSchema } from "./task-registry.js";
import { PiTaskScopeGateway } from "./pi-scope-gateway.js";
import { PiReviewReplyGateway } from "./pi-review-reply-gateway.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!["--data-dir", "--provider", "--model", "--codex-thread", "--codex-bin"].includes(flag) || !value || value.startsWith("--")) throw new Error(`Invalid MCP startup option: ${flag}`);
    options.set(flag, value);
  }
  const dataDir = resolve(options.get("--data-dir") ?? fileURLToPath(new URL("../.vibeguard/", import.meta.url)));
  const model = selectModel(options.get("--provider") ?? "deepseek", options.get("--model"));
  const service = new VerificationService(dataDir, new PiRequirementGateway(model.piProvider, model.modelId, dataDir), `${model.piProvider}/${model.modelId}`, new PiTaskScopeGateway(model.piProvider, model.modelId), new PiReviewReplyGateway(model.piProvider, model.modelId, dataDir));
  const codexThread = options.get("--codex-thread");
  if (codexThread) RefSchema.parse(codexThread);
  if (options.has("--codex-bin") && !codexThread) throw new Error("--codex-bin requires --codex-thread");
  const server = createVibeGuardMcp(service, codexThread ? scope => captureCodexTask(dataDir, codexThread, scope, options.get("--codex-bin")) : undefined);
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
