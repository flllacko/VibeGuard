import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { EvidenceStore } from "./storage.js";
import { verifyDemo } from "./verification.js";
import type { DemoVariant, RunReport, Verdict } from "./contracts.js";
import { readConversation } from "./intake.js";
import { PiRequirementGateway } from "./pi-gateway.js";
import { currentRequirements, resolveRequirements, type Resolution } from "./requirements.js";
import { readResolution, saveConversationCopy, saveResolution } from "./resolution-storage.js";
import { startDemoServer } from "./demo-app.js";
import { demoSnapshotHash, makeManualDemoPlan } from "./demo-plan.js";
import { readPlannedRun, runFrozenPlan, savePlannedRun, type PlannedRunReport } from "./plan-runner.js";
import { readApiProfile, PiPlanGateway } from "./pi-plan-gateway.js";
import { assertPlanRoutes, freezePlan } from "./planning.js";
import { readPlanRecord, savePlanRecord } from "./plan-storage.js";
import { curatedProviders, selectModel } from "./model-selection.js";

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
    console.log("Usage: vibeguard providers\n       vibeguard intake --task FILE [--format text|json]\n       vibeguard resolve --task FILE --provider ID [--model ID] [--format text|json]\n       vibeguard resolution RESOLUTION_ID [--format text|json]\n       vibeguard plan --resolution ID --profile FILE --provider ID [--model ID]\n       vibeguard plan-record PLAN_HASH [--format text|json]\n       vibeguard demo-plan --variant correct|faulty|unavailable [--format text|json]\n       vibeguard planned-report RUN_ID [--format text|json]\n       vibeguard verify --variant correct|faulty|unavailable [--format text|json]\n       vibeguard report RUN_ID [--format text|json]\n       vibeguard evidence EVIDENCE_ID\nAll commands accept [--data-dir PATH].");
    return;
  }
  if (command === "providers") {
    for (const provider of curatedProviders) {
      console.log(`${provider.id}｜默认 ${provider.defaultModel}｜${provider.envVar} ${process.env[provider.envVar] ? "已设置" : "未设置"}｜${provider.description}`);
    }
    console.log("仅显示是否设置，不读取或打印密钥值；模型 API 是否可用仍需实际调用确认。");
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
    const selection = selectModel(option(args, "--provider"), option(args, "--model"));
    const resolution = await resolveRequirements(intake, new PiRequirementGateway(selection.piProvider, selection.modelId));
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
  if (command === "plan") {
    const resolutionId = option(args, "--resolution");
    const profilePath = option(args, "--profile");
    if (!resolutionId || !profilePath) throw new Error("plan requires --resolution and --profile");
    const selection = selectModel(option(args, "--provider"), option(args, "--model"));
    const resolution = await readResolution(resolutionId, dataDir);
    const profile = await readApiProfile(profilePath);
    try {
      const generation = await new PiPlanGateway(selection.piProvider, selection.modelId).propose(resolution, profile);
      const plan = freezePlan(resolution, generation.proposal, "model-proposal");
      assertPlanRoutes(plan, new Set(profile.routes.map(route => `${route.method} ${route.pathTemplate}`)));
      const path = await savePlanRecord(dataDir, { plan, generation: { model: generation.model, promptHash: generation.promptHash, usage: generation.usage, profileId: profile.profileId } });
      console.log(`计划结构已冻结（未执行，预期值与测试数据仍须审查）：${plan.planHash}`);
      for (const row of plan.coverage) console.log(`${row.requirementId}：${row.status}${row.gapReason ? `，${row.gapReason}` : ""}`);
      console.log(`计划文件：${path}`);
    } catch (error) {
      console.error(`无法形成可执行计划：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    }
    return;
  }
  if (command === "plan-record") {
    if (!args[0]) throw new Error("Missing PLAN_HASH");
    const record = await readPlanRecord(dataDir, args[0]);
    if (outputFormat(args) === "json") console.log(JSON.stringify(record, null, 2));
    else {
      console.log(`计划 ${record.plan.planHash}｜模型 ${record.generation.model}｜范围 ${record.generation.profileId}`);
      for (const row of record.plan.coverage) console.log(`${row.requirementId}：${row.status}${row.gapReason ? `，${row.gapReason}` : ""}`);
    }
    return;
  }
  if (command === "demo-plan") {
    const variant = option(args, "--variant") ?? "faulty";
    if (variant !== "correct" && variant !== "faulty" && variant !== "unavailable") throw new Error("Invalid --variant");
    const { resolution, plan } = await makeManualDemoPlan();
    const server = await startDemoServer(variant === "faulty");
    let result;
    try {
      if (variant === "unavailable") await server.close();
      result = await runFrozenPlan(plan, resolution, server.baseUrl, variant === "unavailable" ? "受控演示应用已关闭" : "新启动的受控演示应用", await demoSnapshotHash(variant), new Set(["POST /checkout", "GET /orders/{order-id}"]));
    } finally {
      if (variant !== "unavailable") await server.close();
    }
    const directory = await savePlannedRun(dataDir, result.report, result.evidence);
    if (outputFormat(args) === "json") console.log(JSON.stringify(result.report, null, 2));
    else {
      printPlannedReport(result.report);
      console.log(`原始证据目录：${directory}`);
    }
    process.exitCode = exitCode(result.report.verdict);
    return;
  }
  if (command === "planned-report") {
    if (!args[0]) throw new Error("Missing RUN_ID");
    const report = await readPlannedRun(dataDir, args[0]);
    if (outputFormat(args) === "json") console.log(JSON.stringify(report, null, 2));
    else printPlannedReport(report);
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

function printPlannedReport(report: PlannedRunReport): void {
  const symbol = { VERIFIED: "✅", FAILED: "❌", UNVERIFIABLE: "⚠" } as const;
  console.log(`VibeGuard M3 人工计划样例｜运行 ${report.runId}｜整个任务 ${symbol[report.verdict]} ${report.verdict}`);
  for (const requirement of report.requirements) {
    console.log(`${symbol[requirement.verdict]} ${requirement.normalized}`);
    for (const ref of requirement.sourceRefs) console.log(`  用户原话 [${ref.messageId}:${ref.start}-${ref.end}]：${ref.quote}`);
    console.log(`  原因：${requirement.reason}`);
    const evidenceIds = requirement.evidenceIds ?? [];
    console.log(`  执行证据：${evidenceIds.length ? evidenceIds.join(", ") : requirement.evidenceIds ? "无；本轮未执行检查" : "旧版报告未聚合证据 ID"}`);
  }
  for (const criterion of report.criteria) for (const check of criterion.checks) {
    console.log(`${symbol[check.verdict]} ${check.checkId}：${check.reason}`);
    console.log(`  原始证据 ID：${check.evidenceIds.join(", ")}`);
  }
  for (const limitation of report.limitations) console.log(`范围限制：${limitation}`);
  console.log(`计划摘要：${report.planHash}；演示目标摘要：${report.targetSnapshotHash}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 3;
});
