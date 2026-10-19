import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceRef, Verdict } from "./contracts.js";
import { freezePlan, type FrozenPlan } from "./planning.js";
import { assertPlanMatchesProfile } from "./plan-profile.js";
import type { ApiProfile } from "./pi-plan-gateway.js";
import { currentRequirements, type Resolution } from "./requirements.js";
import { sha256 } from "./storage.js";
import type { FileEvidence } from "./file-runner.js";

export interface HttpStepEvidence {
  evidenceId: string;
  checkId: string;
  stepId: string;
  capturedAt: string;
  request: { method: string; url: string; body?: unknown };
  response?: { status: number; body: unknown };
  error?: string;
  observation?: { runtimeRunId: string; eventIndex: number; bodyBase64?: string; bodyBytes?: number };
}

export interface HttpObservation {
  response?: { status: number; body: unknown };
  error?: string;
  observation?: HttpStepEvidence["observation"];
}
export type HttpTransport = (request: { method: "GET" | "POST"; path: string; body?: unknown }, timeoutMs: number, signal?: AbortSignal) => Promise<HttpObservation>;
export interface PlanRunOptions {
  transport?: HttpTransport; signal?: AbortSignal; maxDurationMs?: number;
  blockedReason?: string; requireObservedPreconditions?: boolean;
  onEvidence?: (item: HttpStepEvidence) => Promise<void>;
  limitations?: string[];
}

export interface PlannedRunReport {
  schemaVersion: 1;
  kind: "planned-http-run" | "planned-file-run";
  runId: string;
  createdAt: string;
  planHash: string;
  targetSnapshotHash: string;
  resolutionId: string;
  conversationSha256: string;
  source: FrozenPlan["source"];
  environment: string;
  requirements: { requirementId: string; normalized: string; sourceRefs: SourceRef[]; verdict: Verdict; reason: string; evidenceIds: string[] }[];
  criteria: { criterionId: string; verdict: Verdict; reason?: string; checks: { checkId: string; verdict: Verdict; evidenceIds: string[]; reason: string }[] }[];
  verdict: Verdict;
  limitations: string[];
}

export async function runFrozenPlan(plan: FrozenPlan, resolution: Resolution, baseUrl: string, environment: string, targetSnapshotHash: string, profile: ApiProfile, options: PlanRunOptions = {}): Promise<{ report: PlannedRunReport; evidence: HttpStepEvidence[] }> {
  if (!resolution.resolutionComplete) throw new Error("Cannot execute plan with incomplete requirement resolution");
  if (!/^[0-9a-f]{64}$/.test(targetSnapshotHash)) throw new Error("Target snapshot hash is required");
  const validatedPlan = freezePlan(resolution, { criteria: plan.criteria, coverage: plan.coverage }, plan.source);
  assertPlanMatchesProfile(validatedPlan, profile);
  const requirements = currentRequirements(resolution.revisions);
  if (plan.resolutionId !== resolution.resolutionId ||
    plan.conversationSha256 !== resolution.conversationSha256 ||
    plan.requirementSnapshotHash !== validatedPlan.requirementSnapshotHash ||
    plan.planHash !== validatedPlan.planHash) {
    throw new Error("Plan does not match current requirement snapshot");
  }
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" || (base.hostname !== "127.0.0.1" && base.hostname !== "localhost") ||
    base.pathname !== "/" || base.search || base.hash || base.username || base.password) {
    throw new Error("M3 runner only accepts a locally controlled HTTP target");
  }
  const evidence: HttpStepEvidence[] = [];
  const report: PlannedRunReport = {
    schemaVersion: 1,
    kind: "planned-http-run",
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    planHash: plan.planHash,
    targetSnapshotHash,
    resolutionId: resolution.resolutionId,
    conversationSha256: resolution.conversationSha256,
    source: plan.source,
    environment,
    requirements: [],
    criteria: [],
    verdict: "UNVERIFIABLE",
    limitations: options.limitations ?? [
      "当前只执行受控的本地 HTTP 计划；没有浏览器、命令、数据库或外部项目隔离能力。",
      "计划中的自然语言前置条件尚未全部由机器独立核对，报告只支持执行过的断言。",
      "当前目标摘要由调用方提供；受控演示仅覆盖演示应用编译文件与变体配置，不是完整工作树快照。",
      "本地证据哈希用于发现读取时的文件变化；与干活 Agent 共享写入权限时，不能防止其同时改写证据和清单。",
      plan.source === "manual-fixture" ? "本次计划为人工固定样本，不能证明模型能自行设计验收。" : "模型规划能力须通过隐藏样本和人工标准答案另行评估。",
    ],
  };
  const duration = options.maxDurationMs ?? 120000;
  if (!Number.isInteger(duration) || duration < 1 || duration > 180000) throw new Error("Invalid plan execution budget");
  const deadline = Date.now() + duration;
  for (const criterion of plan.criteria) {
    const checks: PlannedRunReport["criteria"][number]["checks"] = [];
    for (const check of criterion.checks) {
      if (check.type !== "http_sequence") throw new Error("HTTP runner does not execute file checks");
      const blocked = options.blockedReason ?? (options.signal?.aborted ? "本次执行已取消，步骤未执行" : Date.now() >= deadline ? "执行预算已耗尽，步骤未执行" : undefined);
      const executed = blocked ? { verdict: "UNVERIFIABLE" as const, evidenceIds: [], reason: blocked } : await runHttpSequence(check, base, evidence, options, deadline);
      checks.push({ checkId: check.checkId, ...executed });
    }
    let verdict = combine(checks.map(check => check.verdict));
    const reason = options.requireObservedPreconditions && criterion.preconditions.length ? "存在尚未以执行步骤核对的前置条件：" + criterion.preconditions.join("；") : undefined;
    if (reason && verdict !== "FAILED") verdict = "UNVERIFIABLE";
    report.criteria.push({ criterionId: criterion.criterionId, verdict, ...(reason ? { reason } : {}), checks });
  }
  for (const requirement of requirements) {
    const coverage = plan.coverage.find(row => row.requirementId === requirement.requirementId);
    if (!coverage) throw new Error(`Frozen plan missing requirement ${requirement.requirementId}`);
    const criterionVerdicts = coverage.criterionIds.map(id => report.criteria.find(item => item.criterionId === id)?.verdict ?? "UNVERIFIABLE");
    let verdict = combine(criterionVerdicts);
    if (coverage.status !== "planned" && verdict !== "FAILED") verdict = "UNVERIFIABLE";
    const relevantChecks = report.criteria.filter(item => coverage.criterionIds.includes(item.criterionId)).flatMap(item => item.checks);
    const decisive = relevantChecks.find(item => item.verdict === "FAILED") ?? relevantChecks.find(item => item.verdict === "UNVERIFIABLE");
    report.requirements.push({
      requirementId: requirement.requirementId,
      normalized: requirement.normalized,
      sourceRefs: requirement.sourceRefs,
      verdict,
      reason: coverage.status === "planned" ? (decisive ? `${decisive.checkId}：${decisive.reason}` : report.criteria.find(item => coverage.criterionIds.includes(item.criterionId) && item.reason)?.reason ?? "冻结计划中的检查均有执行证据") : coverage.gapReason ?? "缺少验收检查",
      evidenceIds: [...new Set(relevantChecks.flatMap(item => item.evidenceIds))],
    });
  }
  report.verdict = combine(report.requirements.map(item => item.verdict));
  return { report, evidence };
}

async function runHttpSequence(check: Extract<FrozenPlan["criteria"][number]["checks"][number], { type: "http_sequence" }>, base: URL, evidence: HttpStepEvidence[], options: PlanRunOptions, runDeadline: number): Promise<{ verdict: Verdict; evidenceIds: string[]; reason: string }> {
  const captures = new Map<string, string>();
  const evidenceIds: string[] = [];
  const deadline = Math.min(runDeadline, Date.now() + check.timeoutMs);
  for (const step of check.steps) {
    if (options.signal?.aborted || Date.now() >= deadline) return { verdict: "UNVERIFIABLE", evidenceIds, reason: `${step.stepId}: 已取消或执行预算耗尽，后续步骤未执行` };
    const path = step.pathTemplate.replace(/\{([A-Za-z][A-Za-z0-9_-]*)\}/g, (_match, name: string) => encodeURIComponent(captures.get(name) ?? ""));
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new Error("Step escaped local target origin");
    const item: HttpStepEvidence = {
      evidenceId: randomUUID(),
      checkId: check.checkId,
      stepId: step.stepId,
      capturedAt: new Date().toISOString(),
      request: { method: step.method, url: url.href, ...(step.body !== undefined ? { body: step.body } : {}) },
    };
    evidenceIds.push(item.evidenceId);
    evidence.push(item);
    try {
      const timeoutMs = Math.max(1, deadline - Date.now());
      const observed = options.transport ? await options.transport({ method: step.method, path: url.pathname + url.search, ...(step.body !== undefined ? { body: step.body } : {}) }, timeoutMs, options.signal) : await (async (): Promise<HttpObservation> => {
      const response = await fetch(url, {
        method: step.method,
        redirect: "manual",
        ...(step.body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(step.body) } : {}),
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      if (reader) for (;;) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 65536) { await reader.cancel(); throw new Error("HTTP response exceeds 64 KiB"); }
        chunks.push(next.value);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try { body = JSON.parse(text) as unknown; } catch { body = text; }
      return { response: { status: response.status, body } };
      })();
      item.observation = observed.observation;
      item.response = observed.response;
      if (observed.error || !observed.response) throw new Error(observed.error ?? "缺少实际 HTTP 响应");
      const { status, body } = observed.response;
      if (status !== step.expectedStatus) {
        return { verdict: "FAILED", evidenceIds, reason: `${step.stepId}: HTTP ${status}，预期 ${step.expectedStatus}` };
      }
      for (const assertion of step.assertions) {
        const actual = jsonPointer(body, assertion.pointer);
        if (!actual.found || !isDeepStrictEqual(actual.value, assertion.equals)) {
          return { verdict: "FAILED", evidenceIds, reason: `${step.stepId}: ${assertion.pointer} 实际 ${JSON.stringify(actual.value)}，预期 ${JSON.stringify(assertion.equals)}` };
        }
      }
      for (const capture of step.captures) {
        const value = jsonPointer(body, capture.pointer);
        if (!value.found || (typeof value.value !== "string" && typeof value.value !== "number")) {
          return { verdict: "FAILED", evidenceIds, reason: `${step.stepId}: 无法从 ${capture.pointer} 读取 ${capture.name}` };
        }
        captures.set(capture.name, String(value.value));
      }
    } catch (error) {
      item.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return { verdict: "UNVERIFIABLE", evidenceIds, reason: `${step.stepId}: 请求未完成，${item.error}` };
    } finally { await options.onEvidence?.(item); }
  }
  return { verdict: "VERIFIED", evidenceIds, reason: "计划步骤实际执行，状态码与 JSON 断言均满足" };
}

function jsonPointer(value: unknown, pointer: string): { found: boolean; value: unknown } {
  if (pointer === "") return { found: true, value };
  let current: unknown = value;
  for (const segment of pointer.slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function combine(verdicts: Verdict[]): Verdict {
  if (verdicts.includes("FAILED")) return "FAILED";
  if (verdicts.length === 0 || verdicts.includes("UNVERIFIABLE")) return "UNVERIFIABLE";
  return "VERIFIED";
}

export async function savePlannedRun(dataDir: string, report: PlannedRunReport, evidence: Array<HttpStepEvidence | FileEvidence>): Promise<string> {
  const directory = join(dataDir, "planned-runs", report.runId);
  await mkdir(join(dataDir, "planned-runs"), { recursive: true });
  await mkdir(directory, { recursive: false });
  const files: { name: string; sha256: string }[] = [];
  for (const item of evidence) {
    const name = `${item.evidenceId}.json`;
    const content = JSON.stringify(item, null, 2) + "\n";
    await writeFile(join(directory, name), content, { flag: "wx" });
    files.push({ name, sha256: sha256(content) });
  }
  const content = JSON.stringify(report, null, 2) + "\n";
  await writeFile(join(directory, "report.json"), content, { flag: "wx" });
  files.push({ name: "report.json", sha256: sha256(content) });
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ runId: report.runId, files }, null, 2) + "\n", { flag: "wx" });
  return directory;
}

export async function readPlannedRun(dataDir: string, runId: string): Promise<PlannedRunReport> {
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error("Invalid planned run ID");
  const directory = join(dataDir, "planned-runs", runId);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as { runId: string; files: { name: string; sha256: string }[] };
  if (manifest.runId !== runId) throw new Error("Planned run manifest mismatch");
  let report: PlannedRunReport | null = null;
  for (const file of manifest.files) {
    if (!/^[0-9a-f-]{36}\.json$/.test(file.name) && file.name !== "report.json") throw new Error("Invalid evidence filename in manifest");
    const bytes = await readFile(join(directory, file.name));
    if (sha256(bytes) !== file.sha256) throw new Error(`Evidence hash mismatch: ${file.name}`);
    if (file.name === "report.json") report = JSON.parse(bytes.toString()) as PlannedRunReport;
  }
  if (!report || report.runId !== runId) throw new Error("Missing or mismatched planned report");
  return report;
}
