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
import { freezePlan, type FrozenPlan } from "./planning.js";
import { assertPlanMatchesProfile, profileHash } from "./plan-profile.js";
import type { ApiProfile } from "./pi-plan-gateway.js";
import { readPlanRecord, savePlanRecord } from "./plan-storage.js";
import { curatedProviders, selectModel } from "./model-selection.js";
import { captureTraeHook, exportTraeObservedConversation } from "./host-capture.js";
import { registerTask } from "./task-registry.js";
import { VerificationService } from "./verification-service.js";
import { captureCodexTask } from "./codex-history.js";
import { buildConnectionConfig } from "./connection-config.js";
import { assertEvidenceOutsideRoots, assertFilePlanMatchesProfile, fileProfileHash, readFileProfile, readStoredFileProfile, saveFileProfile } from "./file-profile.js";
import { PiFilePlanGateway } from "./pi-file-plan-gateway.js";
import { buildAcceptancePlan, renderAcceptancePlan } from "./plan-review.js";
import { runConnectionWizard } from "./connection-wizard.js";
import { checkConnection } from "./connection-doctor.js";
import { PiTaskScopeGateway } from "./pi-scope-gateway.js";
import { readScopeProposal, readTaskIntake, scopeReview } from "./task-scope.js";
import { readTask } from "./task-registry.js";
import { confirmedRequirementSnapshot, readRequirementReview, requirementReviewView } from "./requirement-review.js";
import { PiReviewReplyGateway } from "./pi-review-reply-gateway.js";
import { inspectExternalProject, prepareExternalProject } from "./external-project.js";

const args = process.argv.slice(2);
const command = args.shift();
const demoProfilePath = fileURLToPath(new URL("../fixtures/profiles/coupon-api.json", import.meta.url));
const dataFlag = args.indexOf("--data-dir");
let dataDir = fileURLToPath(new URL("../.vibeguard/", import.meta.url));
if (dataFlag >= 0) {
  const supplied = args[dataFlag + 1];
  if (!supplied) throw new Error("--data-dir requires a path");
  dataDir = supplied;
  args.splice(dataFlag, 2);
}

async function main(): Promise<void> {
  if (command === "connect" || command === "doctor") {
    const host = args[0]?.startsWith("--") ? undefined : args[0];
    const options = { dataDir, homeDir: option(args, "--home-dir"), codexBin: option(args, "--codex-bin") };
    if (command === "connect") {
      await runConnectionWizard(host, { ...options, yes: args.includes("--yes"), dryRun: args.includes("--dry-run"), json: outputFormat(args) === "json" });
    } else {
      if (host !== "codex" && host !== "claude-code") throw new Error("doctor requires codex or claude-code");
      const result = await checkConnection(host, options);
      if (outputFormat(args) === "json") console.log(JSON.stringify(result, null, 2));
      else for (const check of result.checks) console.log(`${{ passed: "✅", pending: "⚠", failed: "❌" }[check.status]} ${check.name}：${check.detail}`);
      if (result.status === "needs_fix") process.exitCode = 2;
    }
    return;
  }
  if (command === "setup") {
    const host = args[0];
    if (host !== "codex" && host !== "claude-code") throw new Error("setup currently supports codex or claude-code");
    const guide = buildConnectionConfig(host, { dataDir, codexBin: option(args, "--codex-bin") });
    if (outputFormat(args) === "json") console.log(JSON.stringify(guide, null, 2));
    else {
      console.log("只展示配置，不修改平台设置。验收默认由用户主动调用。\n");
      console.log("在平台的 MCP 添加界面填写：");
      console.log(`名称：vibeguard\n类型：STDIO\n启动命令：${guide.mcp.form.command}\n参数（每行一项）：\n${guide.mcp.form.args.join("\n")}\n工作目录：${guide.mcp.form.workingDirectory}\n环境变量传递：DEEPSEEK_API_KEY\n`);
      console.log("支持 JSON 配置的入口：\n" + JSON.stringify(guide.mcp.json, null, 2));
      if (guide.mcp.toml) console.log("\n需要文件配置时的 TOML：\n" + guide.mcp.toml);
      console.log(`\n对话采集 Hook：合并到 ${guide.collector.hookConfigTarget}，不要覆盖其他配置。\n${JSON.stringify(guide.collector.hooksJson, null, 2)}\n`);
      console.log(guide.collector.approvalEffect);
      console.log("保存、按平台要求信任并重载后，主动说“用 VibeGuard 验收”。工具连接与当前会话采集需要分别确认；详细步骤见 docs/09-user-mcp-setup.md。");
    }
    return;
  }
  if (!command || command === "help") {
    console.log("External projects (preparation only): vibeguard project-prepare --profile FILE --review REVIEW_REF --current-task FRESH_TASK_REF\n                                    vibeguard project-inspect PROJECT_REF\nSaves a delivery copy and confirmed requirement binding; does not execute project code.");
    console.log("Read-only files: vibeguard file-plan --resolution ID --profile FILE [--provider ID]\n                vibeguard register-task --task FILE --file-plan HASH --file-profile FILE\n                vibeguard verify-task TASK_REF");
    console.log("User setup (prints configuration only): vibeguard setup codex|claude-code [--format json] [--codex-bin PATH]");
    console.log("Connection wizard: vibeguard connect [codex|claude-code] [--dry-run | --yes]\n                   vibeguard doctor codex|claude-code\nNon-interactive connect previews only unless --yes is explicitly supplied.");
    console.log("Task scope: vibeguard scope-review PROPOSAL_REF\n            vibeguard verify-task FRESH_TASK_REF --scope-proposal PROPOSAL_REF --candidate S1\nRange selection requires the actual user reply in a fresh host capture; command flags cannot approve it.");
    console.log("Requirements review: vibeguard requirement-review REVIEW_REF [--format json]\n                     vibeguard verify-task FRESH_TASK_REF --review REVIEW_REF\n                     vibeguard confirmed-requirements REVIEW_REF\nCorrections are read from the newly captured original user reply; --review cannot approve on its own.");
    console.log("Usage: vibeguard providers\n       vibeguard intake --task FILE [--format text|json]\n       vibeguard resolve --task FILE --provider ID [--model ID] [--format text|json]\n       vibeguard resolution RESOLUTION_ID [--format text|json]\n       vibeguard capture-trae-hook (reads one Hook JSON from stdin)\n       vibeguard export-trae-session SESSION_ID (prints observed JSON)\n       vibeguard plan --resolution ID --profile FILE --provider ID [--model ID]\n       vibeguard plan-record PLAN_HASH [--format text|json]\n       vibeguard run-demo-plan --plan PLAN_HASH --variant correct|faulty|unavailable [--format text|json]\n       vibeguard demo-plan --variant correct|faulty|unavailable [--format text|json]\n       vibeguard planned-report RUN_ID [--format text|json]\n       vibeguard verify --variant correct|faulty|unavailable [--format text|json]\n       vibeguard report RUN_ID [--format text|json]\n       vibeguard evidence EVIDENCE_ID\nAll commands accept [--data-dir PATH].");
    console.log("Manual acceptance: vibeguard capture-codex THREAD_ID [--scope final|checkpoint] [--codex-bin PATH]\n                   vibeguard register-task --task FILE [--scope final|checkpoint] [--demo-plan HASH --demo-variant correct|faulty|unavailable]\n                   vibeguard verify-task TASK_REF [--force-rerun] [--provider ID] [--model ID]\n                   vibeguard verification RUN_ID\nMCP stdio server: node dist/mcp-entry.js [--data-dir PATH] [--provider ID] [--model ID] [--codex-thread ID --codex-bin PATH]");
    return;
  }
  if (command === "project-prepare") {
    const profile = option(args, "--profile"), review = option(args, "--review"), current = option(args, "--current-task");
    if (!profile || !review || !current) throw new Error("project-prepare requires --profile FILE --review REVIEW_REF --current-task FRESH_TASK_REF");
    const prepared = await prepareExternalProject(dataDir, profile, review, current);
    console.log(JSON.stringify({ taskRef: prepared.task.taskRef, ...await inspectExternalProject(dataDir, prepared.project.projectRef) }, null, 2));
    return;
  }
  if (command === "project-inspect") {
    if (!args[0]) throw new Error("project-inspect requires PROJECT_REF");
    console.log(JSON.stringify(await inspectExternalProject(dataDir, args[0]), null, 2));
    return;
  }
  if (command === "capture-codex") {
    if (!args[0]) throw new Error("capture-codex requires THREAD_ID");
    const scope = option(args, "--scope") ?? "checkpoint";
    if (scope !== "final" && scope !== "checkpoint") throw new Error("Invalid --scope");
    console.log(JSON.stringify(await captureCodexTask(dataDir, args[0], scope, option(args, "--codex-bin")), null, 2));
    return;
  }
  if (command === "register-task") {
    const taskPath = option(args, "--task");
    if (!taskPath) throw new Error("register-task requires --task FILE");
    const scope = option(args, "--scope") ?? "final";
    if (scope !== "final" && scope !== "checkpoint") throw new Error("Invalid --scope");
    const planHash = option(args, "--demo-plan");
    const variant = option(args, "--demo-variant");
    const filePlan = option(args, "--file-plan");
    const fileProfile = option(args, "--file-profile");
    if (Boolean(filePlan) !== Boolean(fileProfile)) throw new Error("--file-plan and --file-profile must be supplied together");
    if (Boolean(planHash) !== Boolean(variant)) throw new Error("--demo-plan and --demo-variant must be supplied together");
    if (variant !== undefined && variant !== "correct" && variant !== "faulty" && variant !== "unavailable") throw new Error("Invalid --demo-variant");
    const task = await registerTask(dataDir, taskPath, scope, planHash && variant ? { planHash, variant } : undefined, filePlan && fileProfile ? { planHash: filePlan, profilePath: fileProfile } : undefined);
    console.log(JSON.stringify(task, null, 2));
    return;
  }
  if (command === "verify-task" || command === "verification") {
    if (!args[0]) throw new Error(`Missing ${command === "verify-task" ? "TASK_REF" : "RUN_ID"}`);
    const model = selectModel(option(args, "--provider") ?? "deepseek", option(args, "--model"));
    const service = new VerificationService(dataDir, new PiRequirementGateway(model.piProvider, model.modelId, dataDir), `${model.piProvider}/${model.modelId}`, new PiTaskScopeGateway(model.piProvider, model.modelId), new PiReviewReplyGateway(model.piProvider, model.modelId, dataDir));
    const proposalRef = option(args, "--scope-proposal"), candidateId = option(args, "--candidate");
    const reviewRef = option(args, "--review");
    if (Boolean(proposalRef) !== Boolean(candidateId)) throw new Error("--scope-proposal and --candidate must be supplied together");
    if (reviewRef && proposalRef) throw new Error("--review 与 --scope-proposal 不能同时使用");
    const result = command === "verify-task" ? await service.request(args[0], args.includes("--force-rerun"), proposalRef && candidateId ? { proposalRef, candidateId } : undefined, reviewRef ? { reviewRef } : undefined) : await service.get(args[0]);
    const final = command === "verify-task" ? await service.wait(result.runId as string) : result;
    console.log(JSON.stringify(final, null, 2));
    if (command === "verify-task") process.exitCode = exitCode(final.verdict as Verdict ?? "UNVERIFIABLE");
    return;
  }
  if (command === "requirement-review" || command === "confirmed-requirements") {
    if (!args[0]) throw new Error(`${command} requires REVIEW_REF`);
    if (command === "confirmed-requirements") console.log(JSON.stringify(await confirmedRequirementSnapshot(dataDir, args[0], option(args, "--current-task")), null, 2));
    else {
      const review = requirementReviewView(await readRequirementReview(dataDir, args[0]));
      console.log(outputFormat(args) === "json" ? JSON.stringify(review, null, 2) : review.text);
    }
    return;
  }
  if (command === "scope-review") {
    if (!args[0]) throw new Error("scope-review requires PROPOSAL_REF");
    const proposal = await readScopeProposal(dataDir, args[0]);
    const intake = await readTaskIntake(dataDir, await readTask(dataDir, proposal.parentTaskRef));
    console.log(JSON.stringify(scopeReview(proposal, intake.conversation), null, 2));
    return;
  }
  if (command === "providers") {
    for (const provider of curatedProviders) {
      console.log(`${provider.id}｜默认 ${provider.defaultModel}｜${provider.envVar} ${process.env[provider.envVar] ? "已设置" : "未设置"}｜${provider.description}`);
    }
    console.log("仅显示是否设置，不读取或打印密钥值；模型 API 是否可用仍需实际调用确认。");
    return;
  }
  if (command === "capture-trae-hook") {
    await captureTraeHook(await readStdin(1024 * 1024), dataDir);
    return;
  }
  if (command === "export-trae-session") {
    if (!args[0]) throw new Error("Missing SESSION_ID");
    console.log(JSON.stringify(await exportTraeObservedConversation(dataDir, args[0]), null, 2));
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
  if (command === "file-plan") {
    const resolutionId = option(args, "--resolution");
    const profilePath = option(args, "--profile");
    if (!resolutionId || !profilePath) throw new Error("file-plan requires --resolution ID and --profile FILE");
    const selection = selectModel(option(args, "--provider") ?? "deepseek", option(args, "--model"));
    const resolution = await readResolution(resolutionId, dataDir);
    const profile = await readFileProfile(profilePath);
    assertEvidenceOutsideRoots(dataDir, profile);
    const generation = await new PiFilePlanGateway(selection.piProvider, selection.modelId).propose(resolution, profile);
    const plan = freezePlan(resolution, generation.proposal, "model-proposal");
    assertFilePlanMatchesProfile(plan, profile);
    await saveFileProfile(dataDir, profile);
    const storedAt = await savePlanRecord(dataDir, { plan, generation: { model: generation.model, promptHash: generation.promptHash, usage: generation.usage, profileId: profile.profileId, profileSha256: fileProfileHash(profile) } });
    console.log(JSON.stringify({ planHash: plan.planHash, storedAt, coverage: plan.coverage, meaning: "计划已冻结，尚未读取交付或得出验收结论" }, null, 2));
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
      assertPlanMatchesProfile(plan, profile);
      const path = await savePlanRecord(dataDir, { plan, generation: { model: generation.model, promptHash: generation.promptHash, usage: generation.usage, profileId: profile.profileId, profileSha256: profileHash(profile) } });
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
      const resolution = await readResolution(record.plan.resolutionId, dataDir);
      let profile;
      if (record.plan.criteria.some(criterion => criterion.checks.some(check => check.type !== "http_sequence"))) {
        try { profile = await readStoredFileProfile(dataDir, record.generation.profileSha256); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      console.log(renderAcceptancePlan(buildAcceptancePlan(record.plan, resolution, profile)));
    }
    return;
  }
  if (command === "demo-plan") {
    const variant = option(args, "--variant") ?? "faulty";
    if (variant !== "correct" && variant !== "faulty" && variant !== "unavailable") throw new Error("Invalid --variant");
    const { resolution, plan } = await makeManualDemoPlan();
    const result = await runDemoVariant(plan, resolution, variant, await readApiProfile(demoProfilePath));
    const directory = await savePlannedRun(dataDir, result.report, result.evidence);
    if (outputFormat(args) === "json") console.log(JSON.stringify(result.report, null, 2));
    else {
      printPlannedReport(result.report);
      console.log(`原始证据目录：${directory}`);
    }
    process.exitCode = exitCode(result.report.verdict);
    return;
  }
  if (command === "run-demo-plan") {
    const hash = option(args, "--plan");
    const variant = option(args, "--variant") ?? "faulty";
    if (!hash) throw new Error("run-demo-plan requires --plan PLAN_HASH");
    if (variant !== "correct" && variant !== "faulty" && variant !== "unavailable") throw new Error("Invalid --variant");
    const record = await readPlanRecord(dataDir, hash);
    if (record.plan.source !== "model-proposal") throw new Error("run-demo-plan requires a model proposal");
    const profile = await readApiProfile(demoProfilePath);
    if (record.generation.profileSha256 !== profileHash(profile)) throw new Error("Plan API profile differs from the current demo profile");
    const resolution = await readResolution(record.plan.resolutionId, dataDir);
    const demo = await makeManualDemoPlan();
    if (resolution.conversationSha256 !== demo.resolution.conversationSha256) throw new Error("Plan was not made for the controlled demo conversation");
    const result = await runDemoVariant(record.plan, resolution, variant, profile);
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

async function readStdin(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new Error("Hook payload exceeds 1 MiB limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function outputFormat(args: string[]): "text" | "json" {
  const format = option(args, "--format") ?? "text";
  if (format !== "text" && format !== "json") throw new Error("Invalid --format");
  return format;
}

function exitCode(verdict: Verdict): number {
  return verdict === "VERIFIED" ? 0 : verdict === "FAILED" ? 1 : 2;
}

async function runDemoVariant(plan: FrozenPlan, resolution: Resolution, variant: "correct" | "faulty" | "unavailable", profile: ApiProfile): ReturnType<typeof runFrozenPlan> {
  const server = await startDemoServer(variant === "faulty");
  try {
    if (variant === "unavailable") await server.close();
    return await runFrozenPlan(plan, resolution, server.baseUrl, variant === "unavailable" ? "受控演示应用已关闭" : "新启动的受控演示应用", await demoSnapshotHash(variant), profile);
  } finally {
    if (variant !== "unavailable") await server.close();
  }
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
  console.log(`VibeGuard M2｜要求整理 ${resolution.resolutionId}｜${resolution.resolutionComplete ? "材料和整理结构检查通过（仍需审查语义）" : "⚠ 尚有缺口，以下清单不是最终当前要求"}`);
  for (const issue of resolution.coverageIssues) console.log(`⚠ ${issue}`);
  for (const requirement of currentRequirements(resolution.revisions)) {
    console.log(`${resolution.resolutionComplete ? "当前要求" : "已见材料的候选要求"} ${requirement.requirementId} v${requirement.revision}：${requirement.normalized}`);
    for (const ref of requirement.sourceRefs) console.log(`  用户原话 [${ref.messageId}:${ref.start}-${ref.end}]：${ref.quote}`);
  }
  for (const revision of resolution.revisions.filter(item => item.status === "cancelled")) {
    console.log(`本次取消 ${revision.requirementId}：${revision.normalized}`);
    for (const ref of revision.sourceRefs) console.log(`  用户原话 [${ref.messageId}:${ref.start}-${ref.end}]：${ref.quote}`);
  }
  for (const chunk of resolution.processing) console.log(`处理块 ${chunk.chunk}：${chunk.status}${chunk.model ? `，模型 ${chunk.model}` : ""}${chunk.error ? `，${chunk.error}` : ""}`);
  if (resolution.interpretedUnits) {
    const labels = { requirement: "要求", authorization: "操作授权", context: "背景或讨论", unresolved: "待确认" };
    console.log("原话拆解（分段去向已核对，不等于语义或执行通过）：");
    for (const unit of resolution.interpretedUnits) console.log(`  [${labels[unit.kind]}] ${unit.quote} → ${unit.requirementIds.join(", ") || unit.reason}`);
  }
  console.log(`原文 SHA-256：${resolution.conversationSha256}`);
}

function printPlannedReport(report: PlannedRunReport): void {
  const symbol = { VERIFIED: "✅", FAILED: "❌", UNVERIFIABLE: "⚠" } as const;
  console.log(`VibeGuard M3 ${report.source === "manual-fixture" ? "人工计划样例" : "模型计划受控演示"}｜运行 ${report.runId}｜整个任务 ${symbol[report.verdict]} ${report.verdict}`);
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
