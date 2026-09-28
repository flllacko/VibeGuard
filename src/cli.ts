import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { EvidenceStore } from "./storage.js";
import { verifyDemo } from "./verification.js";
import type { DemoVariant, RunReport, Verdict } from "./contracts.js";
import { readConversation } from "./intake.js";
import { PiRequirementGateway } from "./pi-gateway.js";
import { currentRequirements, resolveRequirements, type Resolution } from "./requirements.js";
import { readResolution, saveConversationCopy, saveResolution } from "./resolution-storage.js";

const args = process.argv.slice(2);
const command = args.shift();
const dataFlag = args.indexOf("--data-dir");
let dataDir = fileURLToPath(new URL("../.vibeguard/", import.meta.url));
if (dataFlag >= 0) {
  const supplied = args[dataFlag + 1];
  if (!supplied) throw new Error("--data-dir requires a path");
  dataDir = supplied;
  args.splice(dataFlag, 2);
}

async function main(): Promise<void> {
  if (!command || command === "help") {
    console.log("Usage: vibeguard intake --task FILE [--format text|json]\n       vibeguard resolve --task FILE --provider ID --model ID [--format text|json]\n       vibeguard resolution RESOLUTION_ID [--format text|json]\n       vibeguard verify --variant correct|faulty|unavailable [--format text|json]\n       vibeguard report RUN_ID [--format text|json]\n       vibeguard evidence EVIDENCE_ID\nAll commands accept [--data-dir PATH].");
    return;
  }
  if (command === "intake" || command === "resolve") {
    const taskPath = option(args, "--task");
    if (!taskPath) throw new Error("--task FILE is required");
    const intake = await readConversation(taskPath);
    const savedPath = await saveConversationCopy(intake, taskPath, dataDir);
    const format = outputFormat(args);
    if (command === "intake") {
      const summary = {
        taskId: intake.conversation.taskId,
        conversationSha256: intake.rawSha256,
        storedAt: savedPath,
        messageCount: intake.conversation.messages.length,
        userMessageIds: intake.userMessageIds,
        coverageIssues: intake.coverageIssues,
        completenessBasis: intake.conversation.transcriptCoverage.basis,
      };
      if (format === "json") console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(`已导入任务 ${summary.taskId}：${summary.messageCount} 条消息，${summary.userMessageIds.length} 条用户消息`);
        console.log(`完整性依据：${summary.completenessBasis}`);
        for (const issue of summary.coverageIssues) console.log(`⚠ ${issue}`);
        console.log(`原文副本：${summary.storedAt}；SHA-256：${summary.conversationSha256}`);
      }
      process.exitCode = intake.coverageIssues.length ? 2 : 0;
      return;
    }
    const provider = option(args, "--provider");
    const model = option(args, "--model");
    if (!provider || !model) throw new Error("resolve requires --provider ID and --model ID");
    const resolution = await resolveRequirements(intake, new PiRequirementGateway(provider, model));
    await saveResolution(resolution, dataDir);
    if (format === "json") console.log(JSON.stringify(resolution, null, 2));
    else printResolution(resolution);
    process.exitCode = resolution.resolutionComplete ? 0 : 2;
    return;
  }
  if (command === "resolution") {
    if (!args[0]) throw new Error("Missing RESOLUTION_ID");
    const resolution = await readResolution(args[0], dataDir);
    if (outputFormat(args) === "json") console.log(JSON.stringify(resolution, null, 2));
    else printResolution(resolution);
    return;
  }
  const store = await EvidenceStore.open(dataDir);
  try {
    if (command === "verify") {
      const variant = option(args, "--variant") ?? "faulty";
      const format = outputFormat(args);
      if (variant !== "correct" && variant !== "faulty" && variant !== "unavailable") throw new Error("Invalid --variant");
      const report = await verifyDemo(variant as DemoVariant, store);
      if (format === "json") console.log(JSON.stringify(report, null, 2));
      else {
        printReport(report);
        console.log(`证据目录：${join(dataDir, "evidence", report.runId)}`);
      }
      process.exitCode = exitCode(report.verdict);
    } else if (command === "report") {
      const format = outputFormat(args);
      if (!args[0]) throw new Error("Missing RUN_ID");
      const report = store.getReport(args[0]);
      if (!report) throw new Error("Run not found");
      if (format === "json") console.log(JSON.stringify(report, null, 2));
      else printReport(report);
    } else if (command === "evidence") {
      if (!args[0]) throw new Error("Missing EVIDENCE_ID");
      const evidence = await store.getEvidence(args[0]);
      if (!evidence) throw new Error("Evidence not found");
      console.log(JSON.stringify(evidence, null, 2));
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    store.close();
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function outputFormat(args: string[]): "text" | "json" {
  const format = option(args, "--format") ?? "text";
  if (format !== "text" && format !== "json") throw new Error("Invalid --format");
  return format;
}

function exitCode(verdict: Verdict): number {
  return verdict === "VERIFIED" ? 0 : verdict === "FAILED" ? 1 : 2;
}

function printReport(report: RunReport): void {
  const symbol = { VERIFIED: "✅", FAILED: "❌", UNVERIFIABLE: "⚠" } as const;
  console.log(`VibeGuard M1｜运行 ${report.runId}`);
  const taskVerdict = report.taskVerdict ?? "UNVERIFIABLE";
  console.log(`门槛检查：${symbol[report.verdict]} ${report.verdict}；整个任务：${symbol[taskVerdict]} ${taskVerdict}`);
  console.log(`当前要求：${report.requirement}`);
  for (const ref of report.sourceRefs) console.log(`用户原话 [${ref.messageId}:${ref.start}-${ref.end}]：${ref.quote}`);
  console.log(`干活 Agent 声明：${report.deliveryClaim}`);
  for (const check of report.checks) {
    console.log(`${symbol[check.verdict]} ${check.label}`);
    console.log(`  预期：${check.expected}`);
    console.log(`  实际：${check.observed}`);
    console.log(`  证据 ID：${check.evidenceId}；${check.reason}`);
  }
  for (const limitation of report.limitations) console.log(`范围限制：${limitation}`);
  console.log(`代码摘要：${report.codeSnapshotHash}；计划摘要：${report.planHash}`);
}

function printResolution(resolution: Resolution): void {
  console.log(`VibeGuard M2｜要求整理 ${resolution.resolutionId}｜${resolution.resolutionComplete ? "消息均已处理（仍需审查语义）" : "⚠ 尚有缺口"}`);
  for (const requirement of currentRequirements(resolution.revisions)) {
    console.log(`当前要求 ${requirement.requirementId} v${requirement.revision}：${requirement.normalized}`);
    for (const ref of requirement.sourceRefs) console.log(`  用户原话 [${ref.messageId}:${ref.start}-${ref.end}]：${ref.quote}`);
  }
  for (const revision of resolution.revisions.filter(item => item.status === "cancelled")) {
    console.log(`本次取消 ${revision.requirementId}：${revision.normalized}`);
    for (const ref of revision.sourceRefs) console.log(`  用户原话 [${ref.messageId}:${ref.start}-${ref.end}]：${ref.quote}`);
  }
  for (const issue of resolution.coverageIssues) console.log(`⚠ ${issue}`);
  for (const chunk of resolution.processing) console.log(`处理块 ${chunk.chunk}：${chunk.status}${chunk.model ? `，模型 ${chunk.model}` : ""}${chunk.error ? `，${chunk.error}` : ""}`);
  console.log(`原文 SHA-256：${resolution.conversationSha256}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 3;
});
