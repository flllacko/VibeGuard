import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceRef, Verdict } from "./contracts.js";
import { readConversation, type Conversation } from "./intake.js";
import { currentRequirements, resolveRequirements, REQUIREMENT_POLICY_VERSION, type RequirementGateway, type Resolution } from "./requirements.js";
import type { InterpretedUnit } from "./intent-units.js";
import { readResolution, saveResolution } from "./resolution-storage.js";
import { readPlanRecord } from "./plan-storage.js";
import { readApiProfile } from "./pi-plan-gateway.js";
import { profileHash } from "./plan-profile.js";
import { readPlannedRun, runFrozenPlan, savePlannedRun } from "./plan-runner.js";
import { startDemoServer } from "./demo-app.js";
import { demoSnapshotHash } from "./demo-plan.js";
import { sha256 } from "./storage.js";
import { demoProfilePath, readTask, RefSchema, type TaskRecord } from "./task-registry.js";
import { assertEvidenceOutsideRoots, assertFilePlanMatchesProfile, readStoredFileProfile } from "./file-profile.js";
import { captureFileSnapshot, type FileSnapshot } from "./file-snapshot.js";
import { FILE_RUNNER_VERSION, runFilePlan } from "./file-runner.js";
import { freezePlan } from "./planning.js";
import { buildAcceptancePlan } from "./plan-review.js";
import { ScopeGenerationError, proposeTaskScope, readScopeProposal, readTaskIntake, scopeReview, selectTaskScope, type TaskScopeGateway, type TaskSelection } from "./task-scope.js";
import { canInterpretPartialText, MATERIAL_POLICY_VERSION } from "./material-policy.js";
import {
  applyRequirementReviewReply, createRequirementReview, readRequirementReview, requirementReviewView,
  REQUIREMENT_REVIEW_POLICY_VERSION, type RequirementReviewSelection, type StoredRequirementReview,
} from "./requirement-review.js";
import type { ReviewReplyGateway } from "./review-reply-intent.js";
import { inspectExternalProject, readExternalProject } from "./external-project.js";
import { consumeExecutionTicket, issueExecutionTicket } from "./host-execution-ticket.js";
import { checkExecutionCapture } from "./execution-capture.js";
import { readExternalPlan } from "./external-plan.js";
import { externalRequirementOutcomes, readExternalEvidence, readExternalRun, renderExternalRun, runExternalPlan } from "./external-runner.js";

export interface VerificationRecord {
  schemaVersion: 1;
  runId: string;
  taskRef: string;
  scope: TaskRecord["scope"];
  trigger: "manual";
  ownerInstanceId: string;
  conversationSha256: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed";
  verdict?: Verdict;
  gapStage?: "scope" | "material" | "requirements" | "requirements_review" | "execution";
  scopeProposalRef?: string;
  selectedScope?: Conversation["selectedScope"];
  scopeGeneration?: ScopeGenerationError["generation"];
  materialGaps?: Conversation["materialGaps"];
  requirementsStatus?: "partial_text_candidates";
  textCoverage?: Resolution["textCoverage"];
  issues: string[];
  resolutionId?: string;
  requirementReviewRef?: string;
  reportRunId?: string;
  interpretedUnits?: InterpretedUnit[];
  externalProject?: Awaited<ReturnType<typeof inspectExternalProject>>;
  externalPlanRef?: string;
  externalTicketRef?: string;
  externalRunRef?: string;
  requirements: { requirementId: string; normalized: string; sourceRefs: SourceRef[]; verdict: Verdict; reason: string; evidenceIds: string[] }[];
}

export class VerificationService {
  private instanceId = randomUUID();
  private active = new Map<string, Promise<void>>();

  constructor(private dataDir: string, private gateway: RequirementGateway, private modelIdentity: string, private scopeGateway?: TaskScopeGateway, private reviewGateway?: ReviewReplyGateway) {}

  /** Fixed-session fallback captures independently; caller-supplied task references are ignored. */
  async requestCapturedExternal(planRef: string, taskRef: string, scope: "checkpoint" | "final") {
    const capture = await checkExecutionCapture(this.dataDir, (await readExternalPlan(this.dataDir, planRef)).record, taskRef);
    const ticket = await issueExecutionTicket(this.dataDir, planRef, taskRef, "codex", capture.sessionId, `bound-mcp-${randomUUID()}`, scope);
    return this.requestExternal(planRef, ticket, taskRef, scope);
  }

  async requestExternal(planRef: string, ticketRef: string, taskRef: string | undefined, scope: "checkpoint" | "final"): Promise<Record<string, unknown>> {
    const ticket = await consumeExecutionTicket(this.dataDir, ticketRef, planRef, taskRef, scope);
    const key = sha256(JSON.stringify({ host: ticket.capture.host, sessionId: ticket.capture.sessionId, request: ticket.capture.acceptanceRequest!.messageId, planRef, scope }));
    const runId = `${key.slice(0, 8)}-${key.slice(8, 12)}-8${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
    await mkdir(join(this.dataDir, "verifications"), { recursive: true });
    try { await mkdir(this.directory(runId)); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; return { ...await this.get(runId), reused: true }; }
    const record: VerificationRecord = { schemaVersion: 1, runId, taskRef: ticket.capture.taskRef, scope, trigger: "manual", ownerInstanceId: this.instanceId,
      conversationSha256: ticket.capture.conversationSha256, startedAt: new Date().toISOString(), status: "running", issues: [], requirements: [], externalPlanRef: planRef, externalTicketRef: ticketRef };
    await this.save(record);
    const work = (async () => {
      try {
        const result = await runExternalPlan(this.dataDir, planRef, { currentTaskRef: ticket.capture.taskRef });
        record.externalRunRef = result.runId; record.verdict = result.verdict;
        record.requirements = externalRequirementOutcomes(result);
        if (result.verdict === "UNVERIFIABLE") { record.gapStage = "execution"; record.issues = [result.reason]; }
      } catch (error) { record.verdict = "UNVERIFIABLE"; record.gapStage = "execution"; record.issues = [error instanceof Error ? error.message : String(error)]; }
      record.status = "completed"; record.completedAt = new Date().toISOString(); await this.save(record);
    })().catch(error => console.error(`VibeGuard external run ${runId} could not persist completion: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.active.delete(runId));
    this.active.set(runId, work);
    return { ...await this.get(runId), reused: false };
  }

  async request(taskRef: string, forceRerun = false, taskSelection?: TaskSelection, requirementReview?: RequirementReviewSelection): Promise<Record<string, unknown>> {
    if (taskSelection && requirementReview) throw new Error("不能同时选择任务范围和回复要求清单。");
    if (requirementReview) return this.recordReview(await applyRequirementReviewReply(this.dataDir, taskRef, requirementReview, this.reviewGateway), forceRerun);
    if (taskSelection) {
      const selected = await selectTaskScope(this.dataDir, taskRef, taskSelection);
      return this.request(selected.taskRef, forceRerun);
    }
    const task = await readTask(this.dataDir, taskRef);
    if (task.execution.kind === "external_project") {
      const binding = await readExternalProject(this.dataDir, task.execution.projectRef);
      if (binding.project.recordHash !== task.execution.projectRecordHash || binding.requirements.baseConversationSha256 !== task.conversationSha256) throw new Error("Registered external project binding changed");
    }
    let fileSnapshot: FileSnapshot | undefined;
    if (task.execution.kind === "readonly_files") {
      const saved = await readPlanRecord(this.dataDir, task.execution.planHash);
      const resolution = await readResolution(saved.plan.resolutionId, this.dataDir);
      const profile = await readStoredFileProfile(this.dataDir, task.execution.profileSha256);
      const validated = freezePlan(resolution, { criteria: saved.plan.criteria, coverage: saved.plan.coverage }, saved.plan.source);
      if (validated.planHash !== task.execution.planHash || resolution.conversationSha256 !== task.conversationSha256 || saved.generation.profileSha256 !== task.execution.profileSha256) throw new Error("Registered file plan or profile changed");
      assertEvidenceOutsideRoots(this.dataDir, profile);
      assertFilePlanMatchesProfile(validated, profile);
      fileSnapshot = await captureFileSnapshot(profile);
    }
    const key = sha256(JSON.stringify({ task, model: this.modelIdentity, requirementPolicy: this.gateway.policyId ?? REQUIREMENT_POLICY_VERSION, requirementEngine: REQUIREMENT_POLICY_VERSION, scopePolicy: this.scopeGateway?.policyId, materialPolicy: MATERIAL_POLICY_VERSION, requirementReviewPolicy: REQUIREMENT_REVIEW_POLICY_VERSION,
      ...(fileSnapshot ? { fileRunner: FILE_RUNNER_VERSION, fileSnapshotHash: fileSnapshot.snapshotHash } : {}),
    }));
    const runId = forceRerun ? randomUUID() : `${key.slice(0, 8)}-${key.slice(8, 12)}-8${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
    const directory = this.directory(runId);
    await mkdir(join(this.dataDir, "verifications"), { recursive: true });
    try {
      await mkdir(directory);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      return { ...await this.get(runId), reused: true };
    }
    const initial: VerificationRecord = {
      schemaVersion: 1, runId, taskRef, scope: task.scope, trigger: "manual", ownerInstanceId: this.instanceId,
      conversationSha256: task.conversationSha256, startedAt: new Date().toISOString(), status: "running", issues: [], requirements: [],
    };
    await this.save(initial);
    const work = this.execute(initial, task, fileSnapshot).catch(error => {
      // Protocol stdout must contain only MCP messages.
      console.error(`VibeGuard run ${runId} could not persist completion: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => this.active.delete(runId));
    this.active.set(runId, work);
    return { ...await this.get(runId), reused: false };
  }

  async get(runId: string, includeReport = false): Promise<Record<string, unknown>> {
    const record = await this.read(runId);
    if (record.status === "running") {
      const owned = record.ownerInstanceId === this.instanceId && this.active.has(runId);
      return { runId, taskRef: record.taskRef, scope: record.scope, status: owned ? "running" : "indeterminate", ...(owned ? {} : { verdict: "UNVERIFIABLE", issues: ["本进程无法确认此前未完成的运行是否仍在其他进程执行；可能已中断。可稍后查询或明确要求复验。"] }) };
    }
    if (record.externalRunRef) {
      const run = await readExternalRun(this.dataDir, record.externalRunRef);
      if (run.planRef !== record.externalPlanRef || run.captureCheck.status !== "checked_at_capture" || run.captureCheck.taskRef !== record.taskRef || run.captureCheck.conversationSha256 !== record.conversationSha256) throw new Error("External verification source binding mismatch");
      return { runId, taskRef: record.taskRef, scope: record.scope, trigger: "manual", status: "completed", verdict: run.verdict,
        kind: "external-http-verification", externalRunRef: run.runId, requirements: externalRequirementOutcomes(run),
        captureCheck: run.captureCheck, coverage: run.coverage, targetSnapshotHash: run.targetSnapshotHash, issues: record.issues, limitations: run.limitations,
        ...(includeReport ? { report: run, acceptancePlan: run.acceptance, text: renderExternalRun(run) } : {}) };
    }
    if (record.reportRunId) {
      const report = await readPlannedRun(this.dataDir, record.reportRunId);
      if (report.conversationSha256 !== record.conversationSha256) throw new Error("Report conversation differs from registered task");
      let acceptancePlan;
      if (includeReport) {
        const task = await readTask(this.dataDir, record.taskRef);
        if (task.execution.kind === "readonly_files" || task.execution.kind === "controlled_demo") {
          const saved = await readPlanRecord(this.dataDir, task.execution.planHash);
          if (saved.plan.planHash !== report.planHash) throw new Error("Report plan differs from registered task");
          const resolution = await readResolution(saved.plan.resolutionId, this.dataDir);
          const profile = task.execution.kind === "readonly_files" ? await readStoredFileProfile(this.dataDir, task.execution.profileSha256) : undefined;
          acceptancePlan = buildAcceptancePlan(saved.plan, resolution, profile);
        }
      }
      return {
        runId, taskRef: record.taskRef, scope: record.scope, trigger: record.trigger, status: "completed", verdict: report.verdict,
        requirements: report.requirements, issues: record.issues, limitations: report.limitations,
        ...(record.gapStage ? { gapStage: record.gapStage } : {}),
        kind: report.kind, targetSnapshotHash: report.targetSnapshotHash,
        reportRef: record.reportRunId, ...(includeReport ? { report, acceptancePlan } : {}),
      };
    }
    const taskScopeReview = record.scopeProposalRef ? scopeReview(await readScopeProposal(this.dataDir, record.scopeProposalRef),
      (await readTaskIntake(this.dataDir, await readTask(this.dataDir, record.taskRef))).conversation) : undefined;
    const review = record.requirementReviewRef ? await readRequirementReview(this.dataDir, record.requirementReviewRef) : undefined;
    if (review && (review.taskRef !== record.taskRef || review.baseConversationSha256 !== record.conversationSha256 || review.resolutionId !== record.resolutionId)) throw new Error("要求审查与本次任务记录不一致。");
    const requirementReview = review ? requirementReviewView(review) : undefined;
    return {
      runId, taskRef: record.taskRef, scope: record.scope, trigger: record.trigger, status: "completed", verdict: record.verdict,
      gapStage: record.gapStage, issues: record.issues, requirements: record.requirements, resolutionId: record.resolutionId,
      ...(record.externalProject ? { externalProject: record.externalProject } : {}),
      ...(taskScopeReview ? { taskScopeReview } : {}),
      ...(requirementReview ? { requirementReview } : {}),
      ...(record.selectedScope ? { selectedScope: record.selectedScope } : {}),
      ...(record.materialGaps?.length ? { materialGaps: record.materialGaps } : {}),
      ...(record.requirementsStatus ? { requirementsStatus: record.requirementsStatus } : {}),
      ...(record.textCoverage ? { textCoverage: record.textCoverage } : {}),
      ...(record.interpretedUnits?.some(unit => unit.kind === "unresolved") ? { unresolvedText: {
        count: record.interpretedUnits.filter(unit => unit.kind === "unresolved").length,
        items: record.interpretedUnits.filter(unit => unit.kind === "unresolved").slice(0, 5).map(unit => ({ messageId: unit.messageId, start: unit.start, end: unit.start + Math.min(unit.quote.length, 280), quote: unit.quote.slice(0, 280), reason: unit.reason, quoteTruncated: unit.quote.length > 280 })),
        meaning: "展示前 5 个待解释片段；不是新增要求或已发现的代码错误。完整去向可用 includeReport 查看。",
      } } : {}),
      ...(record.scopeGeneration ? { scopeGeneration: includeReport ? record.scopeGeneration : { ...record.scopeGeneration, attempts: record.scopeGeneration.attempts.map(({ responseText, ...attempt }) => attempt) } } : {}),
      ...(record.interpretedUnits ? {
        interpretationCoverage: { classifiedUnits: record.interpretedUnits.length, unresolvedUnits: record.interpretedUnits.filter(unit => unit.kind === "unresolved").length, meaning: "原文分段去向计数，不是语义正确率或运行通过率" },
        ...(includeReport ? { interpretedUnits: record.interpretedUnits } : {}),
      } : {}),
      missingEvidence: record.externalProject ? record.externalProject.missingEvidence : review ? [
        ...review.materialIssues,
        ...review.unresolved.filter(item => !item.resolved).map(item => `${item.displayId}：${item.reason}`),
        ...(review.status !== "confirmed" ? ["用户对当前要求清单的确认"] : []),
        "针对交付快照的实际运行检查记录",
      ] : [...(record.materialGaps?.length ? record.materialGaps.map(item => item.detail) : record.gapStage === "scope" ? ["用户对本次任务范围的明确选择"] : record.gapStage === "execution" ? ["针对交付快照的实际运行检查记录"] : ["完整且无未确定要求的任务材料"]), ...(record.textCoverage?.unresolvedUnits ? [`仍有 ${record.textCoverage.unresolvedUnits} 个可见文字片段需要解释。`] : [])],
      nextStep: record.externalPlanRef ? "执行未取得完成证据，查看 issues 中的实际错误；恢复条件后发送新的独立验收请求。" : record.externalProject ? "外部项目副本与要求版本已绑定。尚需生成验收计划并在 Docker 中执行；准备成功不能视为任务通过。工作区有新修改时重新准备快照。" : review ? review.status === "confirmed"
        ? review.materialIssues.length ? "要求理解已确认，材料缺口仍保留。补齐材料后需登记新快照重新审查；没有执行证据仍无法验证。" : !review.items.some(item => item.status === "active") ? "本次清单没有有效验收目标，已保存排除记录；新增目标后再验收，不会因此宣布通过。" : "已保存这版确认的要求；规划前须重新核对当前聊天。外部项目执行尚未接入，需项目运行配置和隔离执行能力。不得把确认理解当作验收通过。"
        : "将 requirementReview.text 作为完整独立消息原样展示（含短标识，不加前后附言）。用户可直接修改、取消、合并、补充要求，或说明 Q 编号的去向；真实回复后重新采集并传 requirementReview={reviewRef}。修改后展示新清单，再确认。"
        : record.gapStage === "scope" ? "展示 taskScopeReview。请用户选择候选的 confirmationReply（含本次短编号）或要求调整；真实回复后通过采集 Hook 重新调用 verify_task，传入 taskSelection。选择不代表验收通过。" : record.gapStage === "execution" ? "该任务已整理要求，但外部项目执行尚未接入；需要项目运行配置和隔离执行能力。" : record.selectedScope && record.gapStage === "material" ? `${record.requirementsStatus ? "已尝试整理可见文字候选，不能据此执行计划或宣布通过。" : ""}范围已经确认，无须再次选择。请按 materialGaps 中的消息引用补齐材料，再登记新快照复验；现有结论不变为通过。` : "补齐材料或确认含糊要求后，登记新的任务快照再验收。",
    };
  }

  async readEvidence(runId: string, evidenceId: string, offset = 0, limit = 2000): Promise<Record<string, unknown>> {
    RefSchema.parse(evidenceId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8000) throw new Error("Invalid evidence offset or limit");
    const record = await this.read(runId);
    if (record.status === "completed" && record.externalRunRef) {
      await this.get(runId); // Validate job -> archived run -> current-capture binding first.
      const raw = JSON.stringify(await readExternalEvidence(this.dataDir, record.externalRunRef, evidenceId), null, 2) + "\n";
      if (offset > raw.length) throw new Error("Evidence offset is beyond content length");
      return { runId, evidenceId, sha256: sha256(raw), offset, totalChars: raw.length, truncated: offset > 0 || offset + limit < raw.length,
        nextOffset: offset + limit < raw.length ? offset + limit : null, text: raw.slice(offset, offset + limit) };
    }
    if (record.status !== "completed" || !record.reportRunId) throw new Error("This verification has no completed execution evidence");
    const report = await readPlannedRun(this.dataDir, record.reportRunId);
    if (report.conversationSha256 !== record.conversationSha256) throw new Error("Report conversation mismatch");
    const allowed = new Set(report.requirements.flatMap(item => item.evidenceIds));
    if (!allowed.has(evidenceId)) throw new Error("Evidence does not belong to this verification");
    const manifest = JSON.parse(await readFile(join(this.dataDir, "planned-runs", record.reportRunId, "manifest.json"), "utf8")) as { runId: string; files: { name: string; sha256: string }[] };
    const expectedHash = manifest.files.find(file => file.name === `${evidenceId}.json`)?.sha256;
    if (manifest.runId !== record.reportRunId || !expectedHash) throw new Error("Evidence is missing from the run manifest");
    const bytes = await readFile(join(this.dataDir, "planned-runs", record.reportRunId, `${evidenceId}.json`));
    if (sha256(bytes) !== expectedHash) throw new Error(`Evidence hash mismatch: ${evidenceId}.json`);
    const raw = bytes.toString("utf8");
    if (offset > raw.length) throw new Error("Evidence offset is beyond content length");
    return { runId, evidenceId, sha256: sha256(bytes), offset, totalChars: raw.length, truncated: offset > 0 || offset + limit < raw.length, nextOffset: offset + limit < raw.length ? offset + limit : null, text: raw.slice(offset, offset + limit) };
  }

  async wait(runId: string): Promise<Record<string, unknown>> {
    await this.active.get(runId);
    return this.get(runId);
  }

  /** A user-approved interpretation is persisted without inventing execution proof. */
  private async recordReview(review: StoredRequirementReview, forceRerun: boolean): Promise<Record<string, unknown>> {
    const task = await readTask(this.dataDir, review.taskRef);
    const runId = forceRerun ? randomUUID() : review.reviewRef;
    await mkdir(join(this.dataDir, "verifications"), { recursive: true });
    try { await mkdir(this.directory(runId)); }
    catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      return { ...await this.get(runId), reused: true };
    }
    const intake = await readTaskIntake(this.dataDir, task);
    const gapStage = review.materialIssues.length ? "material" : review.status === "confirmed" && review.items.some(item => item.status === "active") ? "execution" : "requirements_review";
    const reason = review.status === "confirmed" ? "用户已确认要求理解；尚无实际运行证据" : "要求清单待纠正或确认；尚无实际运行证据";
    await this.save({
      schemaVersion: 1, runId, taskRef: task.taskRef, scope: task.scope, trigger: "manual", ownerInstanceId: this.instanceId,
      conversationSha256: task.conversationSha256, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      status: "completed", verdict: "UNVERIFIABLE", gapStage, resolutionId: review.resolutionId, requirementReviewRef: review.reviewRef,
      selectedScope: intake.conversation.selectedScope, materialGaps: intake.conversation.materialGaps,
      issues: [reason, ...review.materialIssues],
      requirements: review.items.filter(item => item.status === "active").map(item => ({
        requirementId: item.requirementId, normalized: item.normalized, sourceRefs: item.sourceRefs,
        verdict: "UNVERIFIABLE", reason, evidenceIds: [],
      })),
    });
    return { ...await this.get(runId), reused: false };
  }

  private directory(runId: string): string {
    RefSchema.parse(runId);
    return join(this.dataDir, "verifications", runId);
  }

  private async save(record: VerificationRecord): Promise<void> {
    const directory = this.directory(record.runId);
    const temporary = join(directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    await rename(temporary, join(directory, record.status === "running" ? "started.json" : "completed.json"));
  }

  private async read(runId: string): Promise<VerificationRecord> {
    const directory = this.directory(runId);
    for (let attempt = 0; ; attempt++) {
      try {
        let raw: string;
        try {
          raw = await readFile(join(directory, "completed.json"), "utf8");
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
          raw = await readFile(join(directory, "started.json"), "utf8");
        }
        const record = JSON.parse(raw) as VerificationRecord;
        if (record.runId !== runId || record.schemaVersion !== 1) throw new Error("Verification record mismatch");
        if (record.reportRunId) RefSchema.parse(record.reportRunId);
        if (record.externalRunRef) RefSchema.parse(record.externalRunRef);
        if (record.externalPlanRef) RefSchema.parse(record.externalPlanRef);
        if (record.externalTicketRef) RefSchema.parse(record.externalTicketRef);
        return record;
      } catch (error) {
        if (!hasCode(error, "ENOENT") || attempt >= 20) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }

  private async execute(record: VerificationRecord, task: TaskRecord, fileSnapshot?: FileSnapshot): Promise<void> {
    let failureStage: VerificationRecord["gapStage"] = "material";
    try {
      const intake = await readConversation(join(this.dataDir, "conversations", `${task.conversationSha256}.json`));
      if (intake.rawSha256 !== task.conversationSha256) throw new Error("Registered conversation content hash mismatch");
      record.selectedScope = intake.conversation.selectedScope;
      record.materialGaps = intake.conversation.materialGaps;
      const partialText = task.execution.kind === "requirements_only" && intake.coverageIssues.length > 0 && await canInterpretPartialText(this.dataDir, intake);
      if (intake.coverageIssues.length && !partialText) {
        if (task.execution.kind === "requirements_only" && this.scopeGateway && !intake.conversation.selectedScope && intake.conversation.transcriptCoverage.source === "host_adapter" && intake.conversation.hostCapture?.allReturnedPagesRead && intake.conversation.hostCapture.scopeOnlyGap) {
          failureStage = "scope";
          const proposal = await proposeTaskScope(this.dataDir, task, intake, this.scopeGateway);
          record.scopeProposalRef = proposal.proposalRef;
          record.gapStage = "scope";
          record.issues = ["已取得会话原文，需先选择本次任务范围。", ...intake.coverageIssues, intake.conversation.transcriptCoverage.basis];
        } else {
          record.gapStage = "material";
          record.issues = [...intake.coverageIssues, intake.conversation.transcriptCoverage.basis];
        }
      } else if (task.execution.kind === "requirements_only") {
        failureStage = "requirements";
        const resolution = await resolveRequirements(intake, this.gateway);
        await saveResolution(resolution, this.dataDir);
        record.resolutionId = resolution.resolutionId;
        record.interpretedUnits = resolution.interpretedUnits;
        record.textCoverage = resolution.textCoverage;
        if (partialText) record.requirementsStatus = "partial_text_candidates";
        record.gapStage = partialText ? "material" : resolution.resolutionComplete ? "execution" : "requirements";
        record.issues = resolution.resolutionComplete ? ["已整理要求，尚未执行该外部项目；没有完成证据。"] : [...resolution.coverageIssues, ...(partialText ? ["仅整理可见文字候选；非文字材料仍未解析，未取得运行证据。"] : [])];
        record.requirements = currentRequirements(resolution.revisions).map(item => ({
          requirementId: item.requirementId, normalized: item.normalized, sourceRefs: item.sourceRefs,
          verdict: "UNVERIFIABLE", reason: partialText ? "依据可见文字整理的候选；前文非文字材料未解析，本项没有运行证据" : record.gapStage === "execution" ? "本轮未取得该要求的运行证据" : "要求整理仍有缺口，此项仅为候选要求", evidenceIds: [],
        }));
        const review = await createRequirementReview(this.dataDir, task.taskRef, resolution.resolutionId);
        record.requirementReviewRef = review.reviewRef;
        record.gapStage = review.materialIssues.length ? "material" : "requirements_review";
        record.issues.push("已生成要求审查清单；请用户纠正或确认，确认理解不代表验收通过。");
      } else if (task.execution.kind === "external_project") {
        failureStage = "execution";
        const project = await inspectExternalProject(this.dataDir, task.execution.projectRef);
        record.externalProject = project;
        record.gapStage = "execution";
        record.issues = ["已准备外部项目副本和当前性核对过的要求版本；尚未启动项目，没有执行证据。"];
        record.requirements = project.requirements.map(item => ({ requirementId: item.requirementId, normalized: item.normalized, sourceRefs: item.sourceRefs,
          verdict: "UNVERIFIABLE", reason: "项目准备记录不是完成证据；该要求尚未实际检查", evidenceIds: [] }));
      } else if (task.execution.kind === "readonly_files") {
        failureStage = "execution";
        const saved = await readPlanRecord(this.dataDir, task.execution.planHash);
        const resolution = await readResolution(saved.plan.resolutionId, this.dataDir);
        const profile = await readStoredFileProfile(this.dataDir, task.execution.profileSha256);
        if (resolution.conversationSha256 !== task.conversationSha256 || saved.generation.profileSha256 !== task.execution.profileSha256) throw new Error("File execution binding changed");
        assertEvidenceOutsideRoots(this.dataDir, profile);
        const result = await runFilePlan(saved.plan, resolution, profile, fileSnapshot);
        await savePlannedRun(this.dataDir, result.report, result.evidence);
        record.resolutionId = resolution.resolutionId;
        record.reportRunId = result.report.runId;
        record.verdict = result.report.verdict;
        record.requirements = result.report.requirements;
        if (result.report.verdict === "UNVERIFIABLE") record.gapStage = "execution";
      } else {
        failureStage = "execution";
        const saved = await readPlanRecord(this.dataDir, task.execution.planHash);
        const resolution = await readResolution(saved.plan.resolutionId, this.dataDir);
        if (resolution.conversationSha256 !== task.conversationSha256) throw new Error("Frozen plan conversation mismatch");
        const profile = await readApiProfile(demoProfilePath);
        if (profileHash(profile) !== task.execution.profileSha256 || saved.generation.profileSha256 !== task.execution.profileSha256) throw new Error("Frozen API profile changed");
        const variant = task.execution.variant;
        const app = await startDemoServer(variant === "faulty");
        try {
          if (variant === "unavailable") await app.close();
          const result = await runFrozenPlan(saved.plan, resolution, app.baseUrl, "MCP/CLI 独立运行的受控优惠券样例", await demoSnapshotHash(variant), profile);
          await savePlannedRun(this.dataDir, result.report, result.evidence);
          record.resolutionId = resolution.resolutionId;
          record.reportRunId = result.report.runId;
          record.verdict = result.report.verdict;
          record.requirements = result.report.requirements;
        } finally {
          if (variant !== "unavailable") await app.close();
        }
      }
    } catch (error) {
      record.gapStage ??= failureStage;
      if (error instanceof ScopeGenerationError) record.scopeGeneration = error.generation;
      record.issues.push(error instanceof Error ? error.message : String(error));
    }
    record.verdict ??= "UNVERIFIABLE";
    record.status = "completed";
    record.completedAt = new Date().toISOString();
    await this.save(record);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
