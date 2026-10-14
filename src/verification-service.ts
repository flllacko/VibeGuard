import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceRef, Verdict } from "./contracts.js";
import { readConversation } from "./intake.js";
import { currentRequirements, resolveRequirements, REQUIREMENT_POLICY_VERSION, type RequirementGateway } from "./requirements.js";
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
  gapStage?: "material" | "requirements" | "execution";
  issues: string[];
  resolutionId?: string;
  reportRunId?: string;
  interpretedUnits?: InterpretedUnit[];
  requirements: { requirementId: string; normalized: string; sourceRefs: SourceRef[]; verdict: Verdict; reason: string; evidenceIds: string[] }[];
}

export class VerificationService {
  private instanceId = randomUUID();
  private active = new Map<string, Promise<void>>();

  constructor(private dataDir: string, private gateway: RequirementGateway, private modelIdentity: string) {}

  async request(taskRef: string, forceRerun = false): Promise<Record<string, unknown>> {
    const task = await readTask(this.dataDir, taskRef);
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
    const key = sha256(JSON.stringify({ task, model: this.modelIdentity, requirementPolicy: this.gateway.policyId ?? REQUIREMENT_POLICY_VERSION,
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
    if (record.reportRunId) {
      const report = await readPlannedRun(this.dataDir, record.reportRunId);
      if (report.conversationSha256 !== record.conversationSha256) throw new Error("Report conversation differs from registered task");
      return {
        runId, taskRef: record.taskRef, scope: record.scope, trigger: record.trigger, status: "completed", verdict: report.verdict,
        requirements: report.requirements, issues: record.issues, limitations: report.limitations,
        ...(record.gapStage ? { gapStage: record.gapStage } : {}),
        kind: report.kind, targetSnapshotHash: report.targetSnapshotHash,
        reportRef: record.reportRunId, ...(includeReport ? { report } : {}),
      };
    }
    return {
      runId, taskRef: record.taskRef, scope: record.scope, trigger: record.trigger, status: "completed", verdict: record.verdict,
      gapStage: record.gapStage, issues: record.issues, requirements: record.requirements, resolutionId: record.resolutionId,
      ...(record.interpretedUnits ? {
        interpretationCoverage: { classifiedUnits: record.interpretedUnits.length, unresolvedUnits: record.interpretedUnits.filter(unit => unit.kind === "unresolved").length, meaning: "原文分段去向计数，不是语义正确率或运行通过率" },
        ...(includeReport ? { interpretedUnits: record.interpretedUnits } : {}),
      } : {}),
      missingEvidence: record.gapStage === "execution" ? ["针对交付快照的实际运行检查记录"] : ["完整且无未确定要求的任务材料"],
      nextStep: record.gapStage === "execution" ? "该任务已整理要求，但外部项目执行尚未接入；需要项目运行配置和隔离执行能力。" : "补齐材料或确认含糊要求后，登记新的任务快照再验收。",
    };
  }

  async readEvidence(runId: string, evidenceId: string, offset = 0, limit = 2000): Promise<Record<string, unknown>> {
    RefSchema.parse(evidenceId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8000) throw new Error("Invalid evidence offset or limit");
    const record = await this.read(runId);
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
      if (intake.coverageIssues.length) {
        record.gapStage = "material";
        record.issues = [...intake.coverageIssues, intake.conversation.transcriptCoverage.basis];
      } else if (task.execution.kind === "requirements_only") {
        failureStage = "requirements";
        const resolution = await resolveRequirements(intake, this.gateway);
        await saveResolution(resolution, this.dataDir);
        record.resolutionId = resolution.resolutionId;
        record.interpretedUnits = resolution.interpretedUnits;
        record.gapStage = resolution.resolutionComplete ? "execution" : "requirements";
        record.issues = resolution.resolutionComplete ? ["已整理要求，尚未执行该外部项目；没有完成证据。"] : resolution.coverageIssues;
        record.requirements = currentRequirements(resolution.revisions).map(item => ({
          requirementId: item.requirementId, normalized: item.normalized, sourceRefs: item.sourceRefs,
          verdict: "UNVERIFIABLE", reason: record.gapStage === "execution" ? "本轮未取得该要求的运行证据" : "要求整理仍有缺口，此项仅为候选要求", evidenceIds: [],
        }));
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
