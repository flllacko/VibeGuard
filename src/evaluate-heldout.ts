// Development-only evaluation. The gold rules below are never sent to Pi or the planner.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readConversation } from "./intake.js";
import { startConfiguredCouponServer, type CouponRules } from "./demo-app.js";
import { readResolution } from "./resolution-storage.js";
import { readPlanRecord } from "./plan-storage.js";
import { readApiProfile } from "./pi-plan-gateway.js";
import { profileHash } from "./plan-profile.js";
import { runFrozenPlan, savePlannedRun, type HttpStepEvidence, type PlannedRunReport } from "./plan-runner.js";
import { sha256 } from "./storage.js";
import type { Verdict } from "./contracts.js";

const conversationPath = fileURLToPath(new URL("../fixtures/conversations/heldout-coupon-revisions.json", import.meta.url));
const profilePath = fileURLToPath(new URL("../fixtures/profiles/coupon-api-neutral.json", import.meta.url));
const defaultDataDir = fileURLToPath(new URL("../.vibeguard/", import.meta.url));
const correct: CouponRules = { thresholdCents: 12000, discountCents: 1500 };

const variants: { id: string; rules: CouponRules; expected: Verdict; defect?: "threshold" | "discount"; unavailable?: boolean }[] = [
  { id: "correct", rules: correct, expected: "VERIFIED" },
  { id: "stale-threshold", rules: { thresholdCents: 8000, discountCents: 1500 }, expected: "FAILED", defect: "threshold" },
  { id: "stale-discount", rules: { thresholdCents: 12000, discountCents: 1200 }, expected: "FAILED", defect: "discount" },
  { id: "unavailable", rules: correct, expected: "UNVERIFIABLE", unavailable: true },
];

async function main(): Promise<void> {
  const planFlag = process.argv.indexOf("--plan");
  const dataFlag = process.argv.indexOf("--data-dir");
  const planHash = planFlag >= 0 ? process.argv[planFlag + 1] : undefined;
  const dataDir = dataFlag >= 0 ? process.argv[dataFlag + 1] : defaultDataDir;
  if (!planHash || !dataDir) throw new Error("Usage: node dist/evaluate-heldout.js --plan PLAN_HASH [--data-dir PATH]");
  const record = await readPlanRecord(dataDir, planHash);
  const intake = await readConversation(conversationPath);
  const profile = await readApiProfile(profilePath);
  if (record.plan.source !== "model-proposal" || record.plan.conversationSha256 !== intake.rawSha256 ||
      record.generation.profileSha256 !== profileHash(profile)) {
    throw new Error("This evaluation requires a model plan for the heldout coupon conversation and neutral API profile");
  }
  const resolution = await readResolution(record.plan.resolutionId, dataDir);
  const serverBytes = await readFile(new URL("./demo-app.js", import.meta.url));
  const rows: { variant: string; expected: Verdict; actual: Verdict; validDefectEvidence: boolean | null; matched: boolean; runId: string }[] = [];

  for (const variant of variants) {
    const server = await startConfiguredCouponServer(variant.rules);
    let result: Awaited<ReturnType<typeof runFrozenPlan>>;
    try {
      if (variant.unavailable) await server.close();
      const targetSnapshotHash = sha256(Buffer.concat([serverBytes, Buffer.from(JSON.stringify(variant.rules))]));
      result = await runFrozenPlan(record.plan, resolution, server.baseUrl, `保留样本 ${variant.id}；独立新服务器与内存数据`, targetSnapshotHash, profile);
    } finally {
      if (!variant.unavailable) await server.close();
    }
    await savePlannedRun(dataDir, result.report, result.evidence);
    const validDefectEvidence = variant.defect ? hasDefectEvidence(variant.defect, result.report, result.evidence, record.plan.criteria) : null;
    const matched = result.report.verdict === variant.expected && (validDefectEvidence ?? true);
    rows.push({ variant: variant.id, expected: variant.expected, actual: result.report.verdict, validDefectEvidence, matched, runId: result.report.runId });
    console.log(`${matched ? "PASS" : "MISMATCH"} ${variant.id}: expected=${variant.expected} actual=${result.report.verdict} run=${result.report.runId}${validDefectEvidence === null ? "" : ` defectEvidence=${validDefectEvidence}`}`);
  }

  const evaluationId = randomUUID();
  const directory = join(dataDir, "evaluations");
  await mkdir(directory, { recursive: true });
  const summary = {
    schemaVersion: 1,
    evaluationId,
    createdAt: new Date().toISOString(),
    kind: "heldout-coupon-development-evaluation",
    syntheticCase: true,
    taskId: intake.conversation.taskId,
    conversationSha256: intake.rawSha256,
    planHash: record.plan.planHash,
    model: record.generation.model,
    profileSha256: record.generation.profileSha256,
    goldRules: correct,
    rows,
    passed: rows.every(row => row.matched),
    limitation: "仅一份保留的合成任务和三个受控实现；不能估计通用任务可靠性。",
  };
  const path = join(directory, `${evaluationId}.json`);
  await writeFile(path, JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  console.log(`评估记录：${path}`);
  if (!summary.passed) process.exitCode = 1;
}

function hasDefectEvidence(
  defect: "threshold" | "discount",
  report: PlannedRunReport,
  evidence: HttpStepEvidence[],
  criteria: Awaited<ReturnType<typeof readPlanRecord>>["plan"]["criteria"],
): boolean {
  const failedIds = new Set(report.criteria.flatMap(criterion => criterion.checks)
    .filter(check => check.verdict === "FAILED").flatMap(check => check.evidenceIds));
  for (const item of evidence) {
    if (!failedIds.has(item.evidenceId) || item.request.method !== "POST" || item.response?.status !== 201) continue;
    const request = item.request.body as { amountCents?: unknown } | undefined;
    const response = item.response.body as { discountCents?: unknown } | undefined;
    const check = criteria.flatMap(criterion => criterion.checks).find(candidate => candidate.checkId === item.checkId);
    const step = check?.type === "http_sequence" ? check.steps.find(candidate => candidate.stepId === item.stepId) : undefined;
    const expected = step?.assertions.find(assertion => assertion.pointer === "/discountCents")?.equals;
    if (defect === "threshold" && typeof request?.amountCents === "number" &&
        request.amountCents >= 8000 && request.amountCents < correct.thresholdCents &&
        response?.discountCents === correct.discountCents && expected === 0) return true;
    if (defect === "discount" && typeof request?.amountCents === "number" &&
        request.amountCents >= correct.thresholdCents && response?.discountCents === 1200 &&
        expected === correct.discountCents) return true;
  }
  return false;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 3;
});
