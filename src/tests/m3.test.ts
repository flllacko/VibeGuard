import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertPlanRoutes, freezePlan, type PlanProposal } from "../planning.js";
import { sha256 } from "../storage.js";
import { startDemoServer } from "../demo-app.js";
import { readPlannedRun, runFrozenPlan, savePlannedRun } from "../plan-runner.js";
import type { Resolution } from "../requirements.js";

const baseResolution: Resolution = {
  schemaVersion: 1,
  resolutionId: "fixture-resolution",
  taskId: "fixture-task",
  createdAt: "2026-09-29T00:00:00.000Z",
  conversationSha256: "fixture-conversation-hash",
  transcriptCoverage: { level: "complete", source: "user_export", basis: "fixture supplied in test", missingMessageIds: [] },
  coverageIssues: [],
  revisions: [
    { requirementId: "threshold", revision: 1, status: "active", normalized: "订单满 150 元减 20 元", sourceKind: "explicit_user", sourceRefs: [{ messageId: "u2", start: 0, end: 8, quote: "满 150 元" }] },
    { requirementId: "single-use", revision: 1, status: "active", normalized: "每张券只能使用一次", sourceKind: "explicit_user", sourceRefs: [{ messageId: "u1", start: 0, end: 10, quote: "每张券只能使用一次" }] },
    { requirementId: "expiry", revision: 2, status: "cancelled", normalized: "过期券不能使用", sourceKind: "explicit_user", sourceRefs: [{ messageId: "u3", start: 0, end: 10, quote: "过期券先不做" }] },
  ],
  dispositions: [],
  processing: [],
  unprocessedUserMessageIds: [],
  resolutionComplete: true,
};

const demoRoutes = new Set(["POST /checkout", "GET /orders/{order-id}"]);

function proposal(thresholdCents: number): PlanProposal {
  return {
    criteria: [{
      criterionId: "threshold-boundary",
      requirementIds: ["threshold"],
      sourceKind: "derived_check",
      description: "用临界值和紧邻的低额订单检验门槛",
      preconditions: ["各检查使用独立且未用过的有效券"],
      expected: `订单满 ${thresholdCents / 100} 元减 20 元，少 1 元不优惠`,
      checks: [
        checkoutCheck("at-boundary", thresholdCents, 2000),
        checkoutCheck("below-boundary", thresholdCents - 100, 0),
      ],
    }],
    coverage: [
      { requirementId: "threshold", criterionIds: ["threshold-boundary"], status: "planned" },
      { requirementId: "single-use", criterionIds: [], status: "unverifiable", gapReason: "尚未设计同券重复使用检查" },
    ],
  };
}

function checkoutCheck(checkId: string, amountCents: number, discountCents: number): PlanProposal["criteria"][number]["checks"][number] {
  return {
    checkId,
    type: "http_sequence",
    purpose: `检查 ${amountCents} 分订单`,
    timeoutMs: 5000,
    steps: [
      {
        stepId: "create-order", method: "POST", pathTemplate: "/checkout",
        body: { amountCents, couponCode: checkId }, expectedStatus: 201,
        assertions: [],
        captures: [{ name: "order-id", pointer: "/orderId" }],
      },
      {
        stepId: "read-order", method: "GET", pathTemplate: "/orders/{order-id}",
        expectedStatus: 200,
        assertions: [
          { pointer: "/discountCents", equals: discountCents },
          { pointer: "/totalCents", equals: amountCents - discountCents },
        ],
        captures: [],
      },
    ],
  };
}

test("frozen plan follows changed threshold and keeps untested active requirement visible", () => {
  const first = freezePlan(baseResolution, proposal(15000), "manual-fixture");
  const changedResolution = structuredClone(baseResolution);
  changedResolution.resolutionId = "changed-resolution";
  changedResolution.revisions[0]!.normalized = "订单满 120 元减 20 元";
  const second = freezePlan(changedResolution, proposal(12000), "manual-fixture");
  assert.equal(first.criteria[0]?.checks[1]?.steps[0]?.body && (first.criteria[0].checks[1].steps[0].body as { amountCents: number }).amountCents, 14900);
  assert.equal(second.criteria[0]?.checks[1]?.steps[0]?.body && (second.criteria[0].checks[1].steps[0].body as { amountCents: number }).amountCents, 11900);
  assert.notEqual(first.planHash, second.planHash);
  assert.equal(first.coverage.find(row => row.requirementId === "single-use")?.status, "unverifiable");
  assert.equal(first.coverage.some(row => row.requirementId === "expiry"), false);
});

test("a plan cannot silently omit an active requirement or promote a cancelled one", () => {
  const missing = proposal(15000);
  missing.coverage.pop();
  assert.throws(() => freezePlan(baseResolution, missing, "manual-fixture"), /has no planning destination/);
  const cancelled = proposal(15000);
  cancelled.coverage.push({ requirementId: "expiry", criterionIds: [], status: "unverifiable", gapReason: "unknown" });
  assert.throws(() => freezePlan(baseResolution, cancelled, "manual-fixture"), /inactive or unknown requirement/);
});

test("model output cannot submit verdicts or external HTTP targets through a plan", () => {
  assert.throws(() => freezePlan(baseResolution, { ...proposal(15000), verdict: "VERIFIED" }, "model-proposal"));
  const unsafe = proposal(15000);
  unsafe.criteria[0]!.checks[0]!.steps[0]!.pathTemplate = "https://example.com/checkout";
  assert.throws(() => freezePlan(baseResolution, unsafe, "model-proposal"), /safe relative path/);
});

test("incomplete conversation cannot be promoted to a frozen plan", () => {
  const incomplete = structuredClone(baseResolution);
  incomplete.resolutionComplete = false;
  assert.throws(() => freezePlan(incomplete, proposal(15000), "manual-fixture"), /incomplete/);
});

test("runner revalidates a frozen plan before issuing any request", async () => {
  const plan = freezePlan(baseResolution, proposal(15000), "manual-fixture");
  const tampered = structuredClone(plan);
  tampered.criteria[0]!.checks[0]!.steps[0]!.pathTemplate = "https://example.com/checkout";
  await assert.rejects(
    runFrozenPlan(tampered, baseResolution, "http://127.0.0.1:1", "no server needed", sha256("fixture"), demoRoutes),
    /safe relative path/,
  );
});

test("a plan cannot request a route outside the authorized API profile", async () => {
  const unexpected = proposal(15000);
  unexpected.criteria[0]!.checks[0]!.steps[0]!.pathTemplate = "/admin/delete";
  const plan = freezePlan(baseResolution, unexpected, "model-proposal");
  assert.throws(() => assertPlanRoutes(plan, demoRoutes), /outside the authorized profile/);
  await assert.rejects(
    runFrozenPlan(plan, baseResolution, "http://127.0.0.1:1", "no server needed", sha256("fixture"), demoRoutes),
    /outside the authorized profile/,
  );
});

test("authorized dynamic route accepts equivalent capture names with underscore or camelCase", () => {
  const compatible = proposal(15000);
  compatible.criteria[0]!.checks[0]!.steps[0]!.captures[0]!.name = "order_id";
  compatible.criteria[0]!.checks[0]!.steps[1]!.pathTemplate = "/orders/{order_id}";
  compatible.criteria[0]!.checks[1]!.steps[0]!.captures[0]!.name = "orderId";
  compatible.criteria[0]!.checks[1]!.steps[1]!.pathTemplate = "/orders/{orderId}";
  const plan = freezePlan(baseResolution, compatible, "model-proposal");
  assert.doesNotThrow(() => assertPlanRoutes(plan, demoRoutes));
});

test("frozen checks execute real HTTP calls, inspect stored orders and persist evidence", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vibeguard-m3-"));
  try {
    const plan = freezePlan(baseResolution, proposal(15000), "manual-fixture");
    const correctServer = await startDemoServer(false);
    let correct;
    try { correct = await runFrozenPlan(plan, baseResolution, correctServer.baseUrl, "fresh controlled demo app", sha256("correct fixture app"), demoRoutes); }
    finally { await correctServer.close(); }
    assert.deepEqual(correct.report.criteria[0]?.checks.map(item => item.verdict), ["VERIFIED", "VERIFIED"]);
    assert.equal(correct.report.requirements.find(item => item.requirementId === "threshold")?.verdict, "VERIFIED");
    assert.equal(correct.report.requirements.find(item => item.requirementId === "threshold")?.evidenceIds.length, 4);
    assert.equal(correct.report.requirements.find(item => item.requirementId === "single-use")?.verdict, "UNVERIFIABLE");
    assert.deepEqual(correct.report.requirements.find(item => item.requirementId === "single-use")?.evidenceIds, []);
    assert.equal(correct.report.verdict, "UNVERIFIABLE");

    const faultyServer = await startDemoServer(true);
    let faulty;
    try { faulty = await runFrozenPlan(plan, baseResolution, faultyServer.baseUrl, "fresh controlled demo app", sha256("faulty fixture app"), demoRoutes); }
    finally { await faultyServer.close(); }
    assert.equal(faulty.report.criteria[0]?.checks[1]?.verdict, "FAILED");
    assert.equal(faulty.report.verdict, "FAILED");
    const failureIds = faulty.report.criteria[0]!.checks[1]!.evidenceIds;
    const storedOrderEvidence = faulty.evidence.find(item => item.evidenceId === failureIds[1]);
    assert.equal(storedOrderEvidence?.response?.status, 200);
    assert.equal((storedOrderEvidence?.response?.body as { discountCents: number }).discountCents, 2000);
    await savePlannedRun(dataDir, faulty.report, faulty.evidence);
    const reopened = await readPlannedRun(dataDir, faulty.report.runId);
    assert.equal(reopened.verdict, "FAILED");
    assert.equal(reopened.planHash, plan.planHash);

    const unavailableServer = await startDemoServer(false);
    await unavailableServer.close();
    const unavailable = await runFrozenPlan(plan, baseResolution, unavailableServer.baseUrl, "stopped controlled demo app", sha256("unavailable fixture app"), demoRoutes);
    assert.equal(unavailable.report.verdict, "UNVERIFIABLE");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
