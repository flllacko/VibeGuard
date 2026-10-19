import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createExternalPlan, externalPlanInput, externalPlanView, readExternalPlan, type ExternalPlanGateway } from "../external-plan.js";
import { ApiProfileSchema, type PlanGatewayOutput } from "../pi-plan-gateway.js";
import { projectSnapshotDirectory } from "../project-snapshot.js";
import { prepareRuntimeFixture } from "./helpers/external-project-fixture.js";

const execute = promisify(execFile);
const profile = ApiProfileSchema.parse({ schemaVersion: 1, profileId: "synthetic-service-api", description: "Synthetic API contract, not observed application output",
  routes: [{ method: "GET", pathTemplate: "/health", description: "Read service status", successStatus: 200, responseExample: { ready: true } }], isolationRules: [] });
const good: PlanGatewayOutput = { model: "fixture-no-api", promptHash: "a".repeat(64), usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, proposal: {
  criteria: [{ criterionId: "service", requirementIds: ["reachable-service"], sourceKind: "explicit_user", description: "服务可访问", preconditions: [], expected: "实际请求返回约定状态",
    checks: [{ checkId: "health", type: "http_sequence", purpose: "观察服务", timeoutMs: 1000, steps: [{ stepId: "read", method: "GET", pathTemplate: "/health", expectedStatus: 200, assertions: [], captures: [] }] }] }],
  coverage: [{ requirementId: "reachable-service", criterionIds: ["service"], status: "planned" }],
} };
const gateway = (output = good): ExternalPlanGateway => ({ async propose() { return structuredClone(output); } });
async function temporary(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-external-plan-"));
  try { await action(directory); } finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
}

test("external planner uses reviewed amendments and original quotes rather than the old extracted resolution", async () => temporary(async directory => {
  const amendment = "服务应允许读取运行状态，暂不验其他功能。";
  const fixture = await prepareRuntimeFixture(directory, "throw Error('must not run');", 2000, { amendment });
  let calls = 0;
  const record = await createExternalPlan(fixture.dataDir, fixture.project.projectRef, profile, { async propose(resolution, api) {
    calls++;
    assert.equal(resolution.resolutionId, fixture.project.reviewRef);
    assert.equal(resolution.revisions.length, 1); assert.equal(resolution.revisions[0]!.normalized, amendment.replace(/。$/, ""));
    assert.ok(resolution.revisions[0]!.sourceRefs.some(ref => ref.quote.includes(amendment)));
    assert.equal(api.profileId, profile.profileId);
    return structuredClone(good);
  } });
  assert.equal(calls, 1);
  const view = await externalPlanView(fixture.dataDir, record.planRef);
  assert.equal(view.status, "planned_not_executed"); assert.equal(view.verdict, "UNVERIFIABLE"); assert.deepEqual(view.evidence, []);
  assert.ok(view.text.includes(amendment)); assert.deepEqual(view.coverage.totalRequirements, 1); assert.equal(view.coverage.planned, 1);
  assert.equal((await readExternalPlan(fixture.dataDir, record.planRef)).record.targetSnapshotHash, fixture.project.targetSnapshotHash);
}));

test("omitted requirements, invented links, unauthorized routes, file operations and model verdicts cannot freeze an external HTTP plan", async () => temporary(async directory => {
  const fixture = await prepareRuntimeFixture(directory, "// not executed");
  const missing = structuredClone(good); missing.proposal.coverage = [];
  const invented = structuredClone(good); invented.proposal.criteria[0]!.requirementIds = ["invented"];
  const route = structuredClone(good); (route.proposal.criteria[0]!.checks[0] as any).steps[0].pathTemplate = "/admin";
  const file = structuredClone(good); file.proposal.criteria[0]!.checks = [{ checkId: "disk", type: "entry_exists", purpose: "unavailable operation", target: { rootId: "host", path: "" }, expectedKind: "file" }];
  const verdict = structuredClone(good); (verdict.proposal as any).verdict = "VERIFIED";
  for (const candidate of [missing, invented, route, file, verdict]) await assert.rejects(createExternalPlan(fixture.dataDir, fixture.project.projectRef, profile, gateway(candidate)));
  await assert.rejects(readdir(join(fixture.dataDir, "external-plans")), { code: "ENOENT" });
}));

test("partial and unavailable planning coverage stay visible and never become execution evidence", async () => temporary(async directory => {
  const fixture = await prepareRuntimeFixture(directory, "// not executed");
  for (const status of ["partial", "unverifiable"] as const) {
    const output = structuredClone(good);
    output.proposal.coverage = [{ requirementId: "reachable-service", criterionIds: status === "partial" ? ["service"] : [], status, gapReason: "需要更多可观察接口信息" }];
    if (status === "unverifiable") output.proposal.criteria = [];
    const record = await createExternalPlan(fixture.dataDir, fixture.project.projectRef, profile, gateway(output));
    const view = await externalPlanView(fixture.dataDir, record.planRef);
    assert.equal(view.coverage[status], 1); assert.equal(view.coverage.planned, 0); assert.equal(view.verdict, "UNVERIFIABLE");
    assert.ok(view.text.includes("需要更多可观察接口信息")); assert.equal(view.evidence.length, 0);
  }
}));

test("plan readback rejects modified records, wrong identities and changed frozen source; later workspace edits do not alter the fixed delivery", async () => temporary(async directory => {
  const fixture = await prepareRuntimeFixture(directory, "// frozen");
  const record = await createExternalPlan(fixture.dataDir, fixture.project.projectRef, profile, gateway());
  await writeFile(join(fixture.root, "server.mjs"), "// newer workspace");
  assert.equal((await readExternalPlan(fixture.dataDir, record.planRef)).record.targetSnapshotHash, fixture.project.targetSnapshotHash);
  const path = join(fixture.dataDir, "external-plans", `${record.planRef}.json`), original = await readFile(path, "utf8");
  for (const mutate of [(copy: any) => { copy.apiProfile.routes[0].pathTemplate = "/other"; }, (copy: any) => { copy.projectRef = randomUUID(); },
    (copy: any) => { copy.plan.coverage[0].status = "unverifiable"; }, (copy: any) => { copy.verdict = "VERIFIED"; }]) {
    const copy = JSON.parse(original); mutate(copy); await writeFile(path, JSON.stringify(copy));
    await assert.rejects(readExternalPlan(fixture.dataDir, record.planRef));
  }
  await writeFile(path, original);
  await writeFile(join(projectSnapshotDirectory(fixture.dataDir, fixture.project.snapshotRef), "files", "server.mjs"), "// changed fixed copy");
  await assert.rejects(readExternalPlan(fixture.dataDir, record.planRef), /contents changed/);
}));

test("generation cannot publish a plan if the delivery changes during the model call", async () => temporary(async directory => {
  const fixture = await prepareRuntimeFixture(directory, "// before");
  await assert.rejects(createExternalPlan(fixture.dataDir, fixture.project.projectRef, profile, { async propose() {
    await writeFile(join(projectSnapshotDirectory(fixture.dataDir, fixture.project.snapshotRef), "files", "server.mjs"), "// changed during generation");
    return structuredClone(good);
  } }), /contents changed/);
  await assert.rejects(readdir(join(fixture.dataDir, "external-plans")), { code: "ENOENT" });
}));

test("CLI can preview minimal model input and display a persisted external plan in a separate process without a model or Docker", async () => temporary(async directory => {
  const fixture = await prepareRuntimeFixture(directory, "throw Error('not executed');");
  const apiPath = join(directory, "api.json"); await writeFile(apiPath, JSON.stringify(profile));
  const input = await externalPlanInput(fixture.dataDir, fixture.project.projectRef, profile);
  const preview = await execute(process.execPath, ["dist/cli.js", "project-plan-input", fixture.project.projectRef, "--api-profile", apiPath, "--data-dir", fixture.dataDir]);
  assert.deepEqual(JSON.parse(preview.stdout).modelInput, input.modelInput);
  assert.equal("messages" in input.modelInput, false); assert.equal(JSON.stringify(input.modelInput).includes("SYNTHETIC_SECRET"), false);
  assert.equal(JSON.stringify(input.modelInput).includes(fixture.root.replaceAll("\\", "\\\\")), false);
  const record = await createExternalPlan(fixture.dataDir, fixture.project.projectRef, profile, gateway());
  const restored = await execute(process.execPath, ["dist/cli.js", "project-plan-record", record.planRef, "--format", "json", "--data-dir", fixture.dataDir]);
  const view = JSON.parse(restored.stdout); assert.equal(view.planRef, record.planRef); assert.equal(view.verdict, "UNVERIFIABLE");
  assert.ok(view.text.includes("启动一个可访问的文本服务。"));
}));
