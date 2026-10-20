import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildHttpCoverage } from "../http-coverage.js";
import { freezePlan, type PlanProposal } from "../planning.js";
import { runFrozenPlan, type HttpTransport } from "../plan-runner.js";
import { ApiProfileSchema } from "../pi-plan-gateway.js";
import type { Resolution } from "../requirements.js";

function fixture() {
  const resolution: Resolution = { schemaVersion: 1, resolutionId: randomUUID(), taskId: "synthetic-coverage-test", createdAt: new Date().toISOString(), conversationSha256: "a".repeat(64),
    transcriptCoverage: { level: "complete", source: "user_export", basis: "Synthetic coverage unit test only", missingMessageIds: [] }, coverageIssues: [],
    revisions: ["read", "other", "audit"].map(id => ({ requirementId: id, revision: 1, status: "active", normalized: `${id} original quote`, sourceKind: "explicit_user",
      sourceRefs: [{ messageId: "u1", start: 0, end: id.length, quote: id }] })), dispositions: [], processing: [], unprocessedUserMessageIds: [], resolutionComplete: true };
  const proposal: PlanProposal = { criteria: [{ criterionId: "shared", requirementIds: ["read", "other"], sourceKind: "explicit_user", description: "Synthetic shared check", expected: "exact response", preconditions: [],
    checks: [{ checkId: "sequence", type: "http_sequence", purpose: "Synthetic transport", timeoutMs: 1000, steps: ["one", "two"].map(stepId => ({ stepId, method: "GET", pathTemplate: "/state", expectedStatus: 200, assertions: [{ pointer: "/value", equals: "ok" }], captures: [] })) }] }],
    coverage: [{ requirementId: "read", criterionIds: ["shared"], status: "planned" }, { requirementId: "other", criterionIds: ["shared"], status: "planned" },
      { requirementId: "audit", criterionIds: [], status: "unverifiable", gapReason: "没有审计读取工具" }] };
  const profile = ApiProfileSchema.parse({ schemaVersion: 1, profileId: "synthetic-coverage", description: "No business evidence", routes: [{ method: "GET", pathTemplate: "/state", description: "Synthetic state", successStatus: 200, responseExample: { value: "string" } }] });
  return { resolution, proposal, profile };
}
const ok: HttpTransport = async () => ({ response: { status: 200, body: { value: "ok" } } });
async function execute(f: ReturnType<typeof fixture>, transport = ok, blockedReason?: string) {
  const plan = freezePlan(f.resolution, f.proposal, "manual-fixture");
  const run = await runFrozenPlan(plan, f.resolution, "http://127.0.0.1", "synthetic transport, not real acceptance evidence", "b".repeat(64), f.profile,
    { transport, blockedReason, requireObservedPreconditions: true });
  return { plan, run, view: buildHttpCoverage(plan, f.resolution, run.evidence, run.report, { complete: true, reason: "finished" }) };
}

test("known planning gaps cannot be passed by successful checks; shared steps are counted once, not a confidence score", async () => {
  const f = fixture(), { run, view } = await execute(f);
  assert.equal(run.report.verdict, "UNVERIFIABLE");
  assert.deepEqual(view.counts, { totalRequirements: 3, fullyPlannedRequirements: 2, verifiedRequirements: 2, failedRequirements: 0, unverifiableRequirements: 1, plannedSteps: 2, responseSteps: 2 });
  const audit = view.requirements.find(item => item.requirementId === "audit")!;
  assert.equal(audit.gaps[0]!.stage, "planning"); assert.match(audit.gaps[0]!.reason, /审计/);
  assert.deepEqual(audit.sourceRefs, f.resolution.revisions[2]!.sourceRefs);
  assert.equal(audit.checks.length, 0); assert.match(audit.gaps[0]!.nextAction, /重新生成计划/);
  const omitted = structuredClone(f.proposal); omitted.coverage.pop();
  assert.throws(() => freezePlan(f.resolution, omitted, "manual-fixture"), /no planning destination/);
});

test("execution errors and blocked steps name the missing observations without inventing evidence", async () => {
  const f = fixture(); let calls = 0;
  const { view } = await execute(f, async () => { calls++; return { error: "synthetic connection failure" }; });
  assert.equal(calls, 1); assert.equal(view.counts.responseSteps, 0);
  const read = view.requirements[0]!; assert.equal(read.gaps[0]!.stage, "execution");
  assert.equal(read.gaps[0]!.missingEvidence.length, 2); assert.match(read.gaps[0]!.missingEvidence[0]!, /connection failure/);
  assert.equal(read.checks[0]!.steps[1]!.state, "not_observed"); assert.equal(read.checks[0]!.steps[1]!.evidenceId, undefined);
  const blocked = await execute(f, async () => { throw Error("must not run"); }, "application unavailable");
  assert.equal(blocked.view.counts.responseSteps, 0); assert.match(blocked.view.requirements[0]!.gaps[0]!.reason, /application unavailable/);
});

test("a real mismatch remains a failure alongside planning gaps; failure short circuit is explicit", async () => {
  const { run, view } = await execute(fixture(), async () => ({ response: { status: 200, body: { value: "wrong" } } }));
  assert.equal(run.report.verdict, "FAILED"); assert.equal(view.counts.responseSteps, 1); assert.equal(view.counts.failedRequirements, 2);
  assert.match(view.requirements[0]!.gaps[0]!.nextAction, /先修复/); assert.equal(view.requirements[2]!.gaps[0]!.stage, "planning");
});

test("partial planning, unobserved preconditions and incomplete lifecycle remain separate from received responses", async () => {
  const f = fixture(); f.proposal.coverage[0] = { ...f.proposal.coverage[0]!, status: "partial", gapReason: "另有条件尚无工具" };
  f.proposal.criteria[0]!.preconditions = ["外部测试账号已准备"];
  const { plan, run, view } = await execute(f);
  assert.equal(view.counts.responseSteps, 2); assert.equal(view.counts.verifiedRequirements, 0);
  assert.deepEqual(view.requirements[0]!.gaps.map(item => item.stage), ["planning", "precondition"]);
  const interrupted = buildHttpCoverage(plan, f.resolution, run.evidence, undefined, { complete: false, reason: "没有结束记录" });
  assert.equal(interrupted.counts.responseSteps, 2); assert.equal(interrupted.counts.verifiedRequirements, 0);
  assert.equal(interrupted.lifecycleGaps[0]!.stage, "lifecycle"); assert.match(interrupted.lifecycleGaps[0]!.reason, /结束记录/);
});
