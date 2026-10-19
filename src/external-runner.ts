import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { commandSucceeded, type DockerClient } from "./docker-client.js";
import { HTTP_COLLECTOR, HttpCaptureSchema } from "./docker-http.js";
import { checkExternalProjectRuntime } from "./docker-runtime.js";
import { ExternalPlanRecordSchema, readExternalPlan } from "./external-plan.js";
import { buildAcceptancePlan } from "./plan-review.js";
import { freezePlan } from "./planning.js";
import { readPlannedRun, runFrozenPlan, savePlannedRun, type HttpStepEvidence } from "./plan-runner.js";
import { ProjectHash } from "./project-profile.js";
import type { Resolution } from "./requirements.js";
import { readRuntimeReport } from "./runtime-store.js";
import { sha256 } from "./storage.js";

const StartSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("external-http-run-start"), runId: z.string().uuid(), startedAt: z.string().datetime(),
  planRecord: ExternalPlanRecordSchema, resolution: z.unknown(),
}).strict();
const FinishSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("external-http-run-finish"), runId: z.string().uuid(), completedAt: z.string().datetime(),
  startSha256: ProjectHash, runtimeRunId: z.string().uuid(), runtimeReportSha256: ProjectHash, plannedRunId: z.string().uuid(), plannedReportSha256: ProjectHash,
}).strict();
function directory(dataDir: string, runId: string) { z.string().uuid().parse(runId); return join(dataDir, "external-runs", runId); }
async function sealedWrite(path: string, body: unknown) {
  await writeFile(path, JSON.stringify({ body, sha256: sha256(JSON.stringify(body)) }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
async function sealedRead(path: string): Promise<unknown> {
  const bytes = await readFile(path); if (bytes.length > 16 * 1024 * 1024) throw new Error("External run record exceeds 16 MiB");
  const record = z.object({ body: z.unknown(), sha256: ProjectHash }).strict().parse(JSON.parse(bytes.toString("utf8")));
  if (sha256(JSON.stringify(record.body)) !== record.sha256) throw new Error("External run record integrity mismatch");
  return record.body;
}
const LIMITATIONS = [
  "只证明本次固定交付与冻结计划中已执行的 HTTP 断言；不证明所有功能都正确。",
  "仅支持受控 GET/POST、JSON 断言与顺序步骤；没有浏览器、数据库、认证请求头或并发检查。",
  "请求在隔离容器内由固定采集程序发出，断言在验收进程计算；同容器观察不承诺抵御任意恶意进程干扰。",
  "本地哈希检查内容一致性，不是同权限攻击下的防伪证明；原工作区后续修改不属于这份历史报告。",
];

/** Explicit developer entry: a model/Agent can supply a plan reference, never a verdict or observation. */
export async function runExternalPlan(dataDir: string, planRef: string, options: { client?: DockerClient; signal?: AbortSignal; maxDurationMs?: number } = {}) {
  const { record, resolution } = await readExternalPlan(dataDir, planRef);
  const checks = record.plan.criteria.flatMap(criterion => criterion.checks);
  if (checks.some(check => check.type !== "http_sequence") || checks.length > 40 || checks.reduce((n, check) => n + (check.type === "http_sequence" ? check.steps.length : 0), 0) > 80) throw new Error("External execution supports at most 40 HTTP checks and 80 steps");
  const runId = randomUUID(), root = directory(dataDir, runId);
  await mkdir(join(root, "observations"), { recursive: true });
  const start = StartSchema.parse({ schemaVersion: 1, kind: "external-http-run-start", runId, startedAt: new Date().toISOString(), planRecord: record, resolution });
  await sealedWrite(join(root, "start.json"), start);
  let executed: Awaited<ReturnType<typeof runFrozenPlan>> | undefined;
  const onEvidence = async (item: HttpStepEvidence) => { await sealedWrite(join(root, "observations", `${item.evidenceId}.json`), item); };
  const runtime = await checkExternalProjectRuntime(dataDir, record.projectRef, { client: options.client, signal: options.signal, async onReady(session) {
    const before = await readExternalPlan(dataDir, planRef);
    if (before.record.recordHash !== record.recordHash) throw new Error("External plan changed before execution");
    executed = await runFrozenPlan(record.plan, resolution, `http://127.0.0.1:${session.port}`, "固定交付在 Docker 中实际执行", record.targetSnapshotHash, record.apiProfile,
      { transport: session.request, signal: options.signal, maxDurationMs: options.maxDurationMs, requireObservedPreconditions: true, onEvidence, limitations: LIMITATIONS });
    const after = await readExternalPlan(dataDir, planRef);
    if (after.record.recordHash !== record.recordHash) throw new Error("External plan changed during execution");
    options.signal?.throwIfAborted();
  } });
  if (!executed) executed = await runFrozenPlan(record.plan, resolution, "http://127.0.0.1", "功能步骤未能开始", record.targetSnapshotHash, record.apiProfile,
    { blockedReason: runtime.reason, requireObservedPreconditions: true, limitations: LIMITATIONS });
  await savePlannedRun(dataDir, executed.report, executed.evidence);
  const finish = FinishSchema.parse({ schemaVersion: 1, kind: "external-http-run-finish", runId, completedAt: new Date().toISOString(),
    startSha256: sha256(JSON.stringify(start)), runtimeRunId: runtime.runId, runtimeReportSha256: sha256(JSON.stringify(await readRuntimeReport(dataDir, runtime.runId))),
    plannedRunId: executed.report.runId, plannedReportSha256: sha256(JSON.stringify(executed.report)) });
  await sealedWrite(join(root, "finish.json"), finish);
  return readExternalRun(dataDir, runId);
}

/** Reads archived material, not the latest review/workspace. Later edits cannot erase old evidence. */
export async function readExternalRun(dataDir: string, runId: string) {
  const root = directory(dataDir, runId), start = StartSchema.parse(await sealedRead(join(root, "start.json")));
  if (start.runId !== runId) throw new Error("External run identity mismatch");
  const record = start.planRecord, resolution = start.resolution as Resolution;
  const { recordHash, ...body } = record;
  if (sha256(JSON.stringify(body)) !== recordHash) throw new Error("Archived plan integrity mismatch");
  const frozen = freezePlan(resolution, { criteria: record.plan.criteria, coverage: record.plan.coverage }, record.plan.source);
  if (frozen.planHash !== record.plan.planHash || record.plan.resolutionId !== record.reviewRef || resolution.conversationSha256 !== record.checkedConversationSha256) throw new Error("Archived planning binding mismatch");
  const acceptance = buildAcceptancePlan(record.plan, resolution);
  const names = await readdir(join(root, "observations"));
  if (names.length > 80) throw new Error("Unexpected observation count");
  const journal: HttpStepEvidence[] = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error("Invalid observation name");
    const item = await sealedRead(join(root, "observations", name)) as HttpStepEvidence;
    if (!z.string().uuid().safeParse(item.evidenceId).success || `${item.evidenceId}.json` !== name) throw new Error("Observation identity mismatch");
    journal.push(item);
  }
  let finish: z.infer<typeof FinishSchema>;
  try { finish = FinishSchema.parse(await sealedRead(join(root, "finish.json"))); }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    return { schemaVersion: 1, kind: "external-http-verification", runId, planRef: record.planRef, targetSnapshotHash: record.targetSnapshotHash,
      status: "incomplete", verdict: "UNVERIFIABLE" as const, reason: "没有完成记录；可能仍在运行或已被中断，不能据已有片段宣布通过。", acceptance,
      evidenceIds: journal.map(item => item.evidenceId), observations: journal, journal, report: undefined, runtime: undefined, limitations: LIMITATIONS };
  }
  if (finish.runId !== runId || finish.startSha256 !== sha256(JSON.stringify(start))) throw new Error("External run completion binding mismatch");
  const runtime = await readRuntimeReport(dataDir, finish.runtimeRunId), report = await readPlannedRun(dataDir, finish.plannedRunId);
  if (sha256(JSON.stringify(runtime)) !== finish.runtimeReportSha256 || sha256(JSON.stringify(report)) !== finish.plannedReportSha256 ||
    runtime.projectRef !== record.projectRef || runtime.projectRecordHash !== record.projectRecordHash || runtime.targetSnapshotHash !== record.targetSnapshotHash ||
    report.planHash !== record.plan.planHash || report.targetSnapshotHash !== record.targetSnapshotHash || report.resolutionId !== resolution.resolutionId ||
    report.conversationSha256 !== resolution.conversationSha256) throw new Error("External run evidence binding mismatch");
  const expectedIds = new Set(report.criteria.flatMap(criterion => criterion.checks.flatMap(check => check.evidenceIds)));
  if (journal.length !== expectedIds.size || journal.some(item => !expectedIds.has(item.evidenceId))) throw new Error("Execution journal does not cover report evidence");
  const eventIndexes = new Set<number>();
  for (const item of journal) {
    const persisted = JSON.parse(await readFile(join(dataDir, "planned-runs", report.runId, `${item.evidenceId}.json`), "utf8"));
    if (!isDeepStrictEqual(item, persisted)) throw new Error("Saved evidence differs from execution journal");
    if (!item.observation) { if (item.response || !item.error) throw new Error("Missing actual observation receipt"); continue; }
    const receipt = item.observation, event = runtime.events[receipt.eventIndex];
    if (receipt.runtimeRunId !== runtime.runId || !event || event.step !== "http_request" || eventIndexes.has(receipt.eventIndex) || !event.args.includes(HTTP_COLLECTOR) || !event.args.includes(runtime.containerId!)) throw new Error("Invalid runtime observation reference");
    eventIndexes.add(receipt.eventIndex);
    const request = JSON.parse(Buffer.from(event.args.at(-1)!, "base64").toString("utf8")), url = new URL(item.request.url);
    if (request.method !== item.request.method || request.path !== url.pathname + url.search || !isDeepStrictEqual(request.body, item.request.body)) throw new Error("Recorded HTTP request mismatch");
    if (!commandSucceeded(event.result)) { if (item.response || !item.error) throw new Error("Failed collector cannot supply a successful observation"); continue; }
    const capture = HttpCaptureSchema.safeParse((() => { try { return JSON.parse(event.result.stdout); } catch { return null; } })());
    if (!capture.success || capture.data.error) { if (item.response || !item.error) throw new Error("Invalid collector cannot supply a response"); continue; }
    const raw = capture.data;
    if (raw.bodyBase64 !== receipt.bodyBase64 || raw.bodyBytes !== receipt.bodyBytes) throw new Error("Raw response receipt mismatch");
    const bytes = Buffer.from(raw.bodyBase64 ?? "", "base64");
    if (raw.bodyBase64 === undefined || bytes.length !== raw.bodyBytes || bytes.toString("base64") !== raw.bodyBase64) { if (item.response || !item.error) throw new Error("Incomplete HTTP response cannot be used"); continue; }
    const text = bytes.toString("utf8"); let responseBody: unknown; try { responseBody = JSON.parse(text); } catch { responseBody = text; }
    if (!isDeepStrictEqual(item.response, { status: raw.status, body: responseBody })) throw new Error("HTTP response differs from captured bytes");
  }
  const complete = runtime.status === "ready" && runtime.stage === "execution" && runtime.cleanup.status === "removed";
  return { schemaVersion: 1, kind: "external-http-verification", runId, planRef: record.planRef, targetSnapshotHash: record.targetSnapshotHash,
    status: complete ? "completed" : "incomplete", verdict: complete ? report.verdict : "UNVERIFIABLE" as const,
    reason: complete ? "本次冻结计划已实际执行并保存证据；结论仅适用于列出的范围与交付。" : runtime.reason,
    acceptance, report, runtime: { runId: runtime.runId, status: runtime.status, stage: runtime.stage, cleanup: runtime.cleanup },
    evidenceIds: [...expectedIds], observations: journal, journal: undefined, limitations: LIMITATIONS };
}

export async function readExternalEvidence(dataDir: string, runId: string, evidenceId: string) {
  z.string().uuid().parse(evidenceId);
  const run = await readExternalRun(dataDir, runId);
  if (!run.evidenceIds.includes(evidenceId)) throw new Error("Evidence is outside this run");
  return sealedRead(join(directory(dataDir, runId), "observations", `${evidenceId}.json`));
}

export function renderExternalRun(run: Awaited<ReturnType<typeof readExternalRun>>): string {
  const symbols = { VERIFIED: "✅ 已验证", FAILED: "❌ 验证失败", UNVERIFIABLE: "⚠ 无法验证" };
  const lines = [`# VibeGuard｜${symbols[run.verdict]}`, "", run.reason, ""];
  for (const requirement of run.acceptance.requirements) {
    const outcome = run.report?.requirements.find(item => item.requirementId === requirement.requirementId);
    lines.push(`## ${requirement.normalized}`, "", ...requirement.sourceRefs.flatMap(ref => ref.quote.split("\n").map(line => `> ${line}`)), "");
    for (const criterion of requirement.criteria) lines.push(`怎样算做到：${criterion.expected}`);
    lines.push("", outcome ? `${symbols[outcome.verdict]}：${outcome.reason}` : "⚠ 无法验证：尚无完整执行结果", "");
    if (outcome) for (const id of outcome.evidenceIds) lines.push(`证据：${id}`);
    if (outcome) for (const item of run.observations.filter(item => outcome.evidenceIds.includes(item.evidenceId))) {
      const compact = (value: unknown) => { const text = JSON.stringify(value); return text === undefined ? "" : text.length > 600 ? text.slice(0, 600) + "…（摘要截断，完整内容见证据）" : text; };
      lines.push(`实际观察：${item.request.method} ${new URL(item.request.url).pathname} ${compact(item.request.body)} → ${item.response ? `HTTP ${item.response.status} ${compact(item.response.body)}` : item.error ?? "未取得响应"}`);
    }
    if (requirement.gapReason) lines.push(`缺口：${requirement.gapReason}`);
    lines.push("");
  }
  if (run.report) for (const criterion of run.report.criteria) for (const check of criterion.checks) lines.push(`${symbols[check.verdict]} ${check.checkId}：${check.reason}`);
  lines.push("", ...run.limitations.map(item => `范围限制：${item}`), "", `运行编号：${run.runId}`, `交付摘要：${run.targetSnapshotHash}`);
  return lines.join("\n");
}
