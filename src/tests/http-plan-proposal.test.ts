import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { proposeHttpPlanWithRepair, type RawPlanAttempt } from "../http-plan-proposal.js";
import { ApiProfileSchema } from "../pi-plan-gateway.js";
import { freezePlan, type PlanProposal } from "../planning.js";
import { runFrozenPlan } from "../plan-runner.js";
import type { Resolution } from "../requirements.js";

function fixture() {
  const text = "保存后能读取，并返回相同标识。";
  const resolution: Resolution = { schemaVersion: 1, resolutionId: randomUUID(), taskId: "synthetic-capture-comparison", createdAt: new Date().toISOString(),
    conversationSha256: "a".repeat(64), transcriptCoverage: { level: "complete", source: "user_export", basis: "Synthetic unit test", missingMessageIds: [] },
    coverageIssues: [], revisions: [{ requirementId: "save", revision: 1, status: "active", normalized: text, sourceKind: "explicit_user",
      sourceRefs: [{ messageId: "u1", start: 0, end: text.length, quote: text }] }], dispositions: [], processing: [], unprocessedUserMessageIds: [], resolutionComplete: true };
  const profile = ApiProfileSchema.parse({ schemaVersion: 1, profileId: "synthetic-records", description: "Synthetic contract", routes: [
    { method: "POST", pathTemplate: "/records", description: "Create", successStatus: 201, responseExample: { id: "dynamic", serial: 1 } },
    { method: "GET", pathTemplate: "/records/{id}", description: "Read", successStatus: 200, responseExample: { id: "dynamic", serial: 1, literal: "example" } },
  ], isolationRules: [] });
  const proposal: PlanProposal = { criteria: [{ criterionId: "roundtrip", requirementIds: ["save"], sourceKind: "explicit_user", description: "读回标识", expected: "标识和数值相同", preconditions: [], checks: [
    { checkId: "sequence", type: "http_sequence", purpose: "真实动态值比较", timeoutMs: 2000, steps: [
      { stepId: "create", method: "POST", pathTemplate: "/records", body: {}, expectedStatus: 201, assertions: [], captures: [{ name: "created", pointer: "/id" }, { name: "serial", pointer: "/serial" }] },
      { stepId: "read", method: "GET", pathTemplate: "/records/{created}", expectedStatus: 200, captures: [], assertions: [
        { pointer: "/id", equalsCapture: "created" }, { pointer: "/serial", equalsCapture: "serial" }, { pointer: "/literal", equals: "{created}" }] },
    ] },
  ] }], coverage: [{ requirementId: "save", criterionIds: ["roundtrip"], status: "planned" }] };
  return { resolution, profile, proposal };
}
const response = (text: string, stopReason = "stop"): RawPlanAttempt => ({ text, stopReason, model: "unit-fixture-no-api", promptHash: "b".repeat(64),
  usage: { inputTokens: 11, outputTokens: 7, estimatedCostUsd: 0.001 } });

test("plan correction is bounded, validates references/contracts and accumulates every attempt's usage", async () => {
  const f = fixture(), invalid = structuredClone(f.proposal) as any; invalid.criteria[0].coverage = {};
  let calls = 0;
  const result = await proposeHttpPlanWithRepair(f.resolution, f.profile, async (feedback, attempt) => {
    calls++; assert.equal(attempt, calls);
    if (attempt === 1) assert.equal(feedback, undefined);
    else { assert.match(feedback!, /coverage/); assert.match(feedback!, /不要改变用户要求/); }
    return response(JSON.stringify(attempt === 1 ? invalid : f.proposal));
  });
  assert.equal(calls, 2); assert.equal(result.modelCalls, 2); assert.deepEqual(result.usage, { inputTokens: 22, outputTokens: 14, estimatedCostUsd: 0.002 });
  assert.deepEqual(result.proposal, f.proposal);
  let rejected = 0;
  await assert.rejects(proposeHttpPlanWithRepair(f.resolution, f.profile, async () => { rejected++; return response(JSON.stringify({ criteria: [], coverage: [] })); }), /after one correction/);
  assert.equal(rejected, 2);
});

test("network errors and incomplete or error model responses do not trigger automatic retries", async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(proposeHttpPlanWithRepair(f.resolution, f.profile, async () => { calls++; throw new Error("synthetic network failure"); }), /network failure/);
  assert.equal(calls, 1);
  for (const reason of ["error", "length"]) {
    calls = 0;
    await assert.rejects(proposeHttpPlanWithRepair(f.resolution, f.profile, async () => { calls++; return response("{}", reason); }), /without a complete answer/);
    assert.equal(calls, 1);
  }
});

test("capture assertions reject future, cross-check, missing and ambiguous values before execution", () => {
  const f = fixture();
  const steps = () => { const copy = structuredClone(f.proposal); const check = copy.criteria[0]!.checks[0]!; if (check.type !== "http_sequence") throw Error(); return { copy, check }; };
  const future = steps(); future.check.steps[0]!.assertions = [{ pointer: "/id", equalsCapture: "created" }];
  assert.throws(() => freezePlan(f.resolution, future.copy, "manual-fixture"), /unknown or future capture/);
  const missing = steps(); missing.check.steps[1]!.assertions = [{ pointer: "/id", equalsCapture: "unknown" }];
  assert.throws(() => freezePlan(f.resolution, missing.copy, "manual-fixture"), /unknown or future capture/);
  const crossCheck = steps(); crossCheck.copy.criteria[0]!.checks.push({ ...crossCheck.check, checkId: "separate", steps: [crossCheck.check.steps[1]!] });
  assert.throws(() => freezePlan(f.resolution, crossCheck.copy, "manual-fixture"), /unknown capture|unknown or future capture/);
  const both = steps(); both.check.steps[1]!.assertions = [{ pointer: "/id", equalsCapture: "created", equals: "literal" }];
  assert.throws(() => freezePlan(f.resolution, both.copy, "manual-fixture"), /exactly one/);
  const absent = steps(); absent.check.steps[1]!.assertions = [{ pointer: "/id" }];
  assert.throws(() => freezePlan(f.resolution, absent.copy, "manual-fixture"), /exactly one/);
});

test("real HTTP roundtrip compares runtime-generated string and number captures; literal braces stay literal and mismatches fail", async () => {
  const f = fixture(), id = randomUUID(); let bad = false;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") { req.resume(); res.statusCode = 201; res.end(JSON.stringify({ id, serial: 23 })); }
    else { assert.equal(req.url, `/records/${id}`); res.end(JSON.stringify({ id: bad ? "wrong-id" : id, serial: 23, literal: "{created}" })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const plan = freezePlan(f.resolution, f.proposal, "manual-fixture");
  try {
    const correct = await runFrozenPlan(plan, f.resolution, `http://127.0.0.1:${address.port}`, "real local HTTP unit fixture", "c".repeat(64), f.profile);
    assert.equal(correct.report.verdict, "VERIFIED"); assert.equal(correct.evidence.length, 2);
    bad = true;
    const failed = await runFrozenPlan(plan, f.resolution, `http://127.0.0.1:${address.port}`, "real local HTTP unit fixture", "c".repeat(64), f.profile);
    assert.equal(failed.report.verdict, "FAILED"); assert.match(failed.report.requirements[0]!.reason, /wrong-id/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
