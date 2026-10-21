import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { prepareRuntimeFixture } from "./helpers/external-project-fixture.js";
import { createExternalPlan } from "../external-plan.js";
import { ApiProfileSchema, type PlanGatewayOutput } from "../pi-plan-gateway.js";
import { readTask } from "../task-registry.js";
import { readTaskIntake } from "../task-scope.js";
import { confirmedRequirementSnapshot, readRequirementReview } from "../requirement-review.js";
import { registerEvaluationReply } from "../evaluate-revision-run.js";
import { prepareVerificationHook, verificationToolName } from "../capture-hook.js";
import { consumeExecutionTicket } from "../host-execution-ticket.js";

const profile = ApiProfileSchema.parse({ schemaVersion: 1, profileId: "synthetic-host-status", description: "Synthetic contract", routes: [
  { method: "GET", pathTemplate: "/health", description: "Read status", successStatus: 200, responseExample: { ready: true } }] });
const proposal = (): PlanGatewayOutput => ({ model: "fixture-no-api", promptHash: "a".repeat(64), usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, proposal: {
  criteria: [{ criterionId: "status", requirementIds: ["reachable-service"], sourceKind: "explicit_user", description: "Read status", expected: "ready=true", preconditions: [], checks: [
    { checkId: "read-status", type: "http_sequence", purpose: "Synthetic check", timeoutMs: 1000, steps: [{ stepId: "read", method: "GET", pathTemplate: "/health", expectedStatus: 200, assertions: [{ pointer: "/ready", equals: true }], captures: [] }] }] }],
  coverage: [{ requirementId: "reachable-service", criterionIds: ["status"], status: "planned" }],
} });
async function temporary(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-host-execution-"));
  try { await action(directory); } finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
}
async function fixture(directory: string) {
  const sessionId = randomUUID(), fixture = await prepareRuntimeFixture(directory, "// synthetic fixture, never host execution", 2000, { syntheticCodexSessionId: sessionId });
  const plan = await createExternalPlan(fixture.dataDir, fixture.project.projectRef, profile, { async propose() { return proposal(); } });
  const review = await readRequirementReview(fixture.dataDir, fixture.project.reviewRef), original = await readTaskIntake(fixture.dataDir, await readTask(fixture.dataDir, fixture.project.currentTaskRef));
  const capture = await registerEvaluationReply(fixture.dataDir, original.conversation, review, "用 VibeGuard 验收", join(directory, "request.json"));
  const hook = (input: Record<string, unknown> = {}, taskRef = capture.task.taskRef) => prepareVerificationHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: verificationToolName,
    session_id: sessionId, cwd: directory, tool_use_id: `call-${randomUUID()}`, tool_input: { externalPlanRef: plan.planRef, ...input } }), { host: "codex", dataDir: fixture.dataDir }, async () => ({ taskRef }));
  return { ...fixture, sessionId, plan, review, original, capture, hook };
}
const unpack = (result: CallToolResult): Record<string, any> => { assert.equal(result.isError, undefined); return result.structuredContent as Record<string, any>; };

test("Hook always replaces caller task/ticket for external execution; reserved request stays in raw source but is not a business amendment", async () => temporary(async directory => {
  const f = await fixture(directory), output = await f.hook({ taskRef: randomUUID(), captureTicket: randomUUID() });
  const input = output.hookSpecificOutput!.updatedInput!;
  assert.equal(input.taskRef, f.capture.task.taskRef); assert.equal(output.hookSpecificOutput!.permissionDecision, "allow"); assert.ok(input.captureTicket);
  assert.equal(JSON.stringify(output).includes("用 VibeGuard 验收"), false);
  await assert.rejects(confirmedRequirementSnapshot(f.dataDir, f.review.reviewRef, input.taskRef), /New user messages require review/);
  const ticket = await consumeExecutionTicket(f.dataDir, input.captureTicket!, f.plan.planRef, input.taskRef, "checkpoint");
  assert.equal(ticket.capture.acceptanceRequest!.quote, "用 VibeGuard 验收");
  assert.equal(ticket.capture.acceptanceRequest!.messageId, f.capture.conversation.messages.at(-1)!.id);
  assert.equal(ticket.capture.conversationSha256, f.capture.task.conversationSha256);
  const stored = await readFile(join(f.dataDir, "conversations", `${f.capture.task.conversationSha256}.json`), "utf8"); assert.ok(stored.includes("用 VibeGuard 验收"));
  await assert.rejects(consumeExecutionTicket(f.dataDir, input.captureTicket!, f.plan.planRef, input.taskRef, "checkpoint"), { code: "EEXIST" });
}));

test("mixed requests, unreviewed earlier changes and capture failure cannot obtain an external execution ticket", async () => temporary(async directory => {
  const f = await fixture(directory);
  let failedCaptures = 0;
  const unavailable = await prepareVerificationHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: verificationToolName, session_id: f.sessionId, cwd: directory,
    tool_use_id: "capture-error", tool_input: { externalPlanRef: f.plan.planRef, taskRef: f.capture.task.taskRef } }), { host: "codex", dataDir: f.dataDir },
    async () => { failedCaptures++; throw new Error("PRIVATE_CAPTURE_FAILURE"); });
  assert.equal(failedCaptures, 1); assert.equal(unavailable.hookSpecificOutput!.permissionDecision, "deny"); assert.equal(JSON.stringify(unavailable).includes("PRIVATE_CAPTURE_FAILURE"), false);
  for (const [index, text] of ["用 VibeGuard 验收，另加一个功能", "请验收一下", "他说：用 VibeGuard 验收"].entries()) {
    const capture = await registerEvaluationReply(f.dataDir, f.original.conversation, f.review, text, join(directory, `invalid-${index}.json`));
    assert.equal((await f.hook({}, capture.task.taskRef)).hookSpecificOutput!.permissionDecision, "deny");
  }
  const earlier = await registerEvaluationReply(f.dataDir, f.original.conversation, f.review, "先改成另一个功能", join(directory, "earlier.json"));
  const command = await registerEvaluationReply(f.dataDir, earlier.conversation, f.review, "用 VibeGuard 验收", join(directory, "later-command.json"));
  assert.equal((await f.hook({}, command.task.taskRef)).hookSpecificOutput!.permissionDecision, "deny");
  await assert.rejects(readdir(join(f.dataDir, "execution-tickets")), { code: "ENOENT" });
}));

test("ticket binds plan, capture and scope; an exclusive claim stops concurrent replay", async () => temporary(async directory => {
  const f = await fixture(directory), input = (await f.hook()).hookSpecificOutput!.updatedInput!;
  await assert.rejects(consumeExecutionTicket(f.dataDir, input.captureTicket!, randomUUID(), input.taskRef, "checkpoint"), /binding mismatch/);
  await assert.rejects(consumeExecutionTicket(f.dataDir, input.captureTicket!, f.plan.planRef, randomUUID(), "checkpoint"), /binding mismatch/);
  await assert.rejects(consumeExecutionTicket(f.dataDir, input.captureTicket!, f.plan.planRef, input.taskRef, "final"), /binding mismatch/);
  const attempts = await Promise.allSettled([1, 2].map(() => consumeExecutionTicket(f.dataDir, input.captureTicket!, f.plan.planRef, input.taskRef, "checkpoint")));
  assert.equal(attempts.filter(item => item.status === "fulfilled").length, 1); assert.equal(attempts.filter(item => item.status === "rejected").length, 1);
}));

test("new standalone requests can start a new run while assistant-only recaptures retain the same request identity", async () => temporary(async directory => {
  const f = await fixture(directory), firstInput = (await f.hook()).hookSpecificOutput!.updatedInput!;
  const first = await consumeExecutionTicket(f.dataDir, firstInput.captureTicket!, f.plan.planRef, firstInput.taskRef, "checkpoint");
  const next = await registerEvaluationReply(f.dataDir, f.capture.conversation, f.review, "用 VibeGuard 验收", join(directory, "request-again.json"));
  const nextInput = (await f.hook({}, next.task.taskRef)).hookSpecificOutput!.updatedInput!;
  const second = await consumeExecutionTicket(f.dataDir, nextInput.captureTicket!, f.plan.planRef, nextInput.taskRef, "checkpoint");
  assert.notEqual(first.capture.acceptanceRequest!.messageId, second.capture.acceptanceRequest!.messageId);
  assert.equal(second.capture.acceptanceRequest!.quote, "用 VibeGuard 验收");
}));

test("expired tickets are rejected without execution", async t => temporary(async directory => {
  const f = await fixture(directory), input = (await f.hook()).hookSpecificOutput!.updatedInput!;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 120001 });
  try { await assert.rejects(consumeExecutionTicket(f.dataDir, input.captureTicket!, f.plan.planRef, input.taskRef, "checkpoint"), /expired/); }
  finally { t.mock.timers.reset(); }
}));

test("stdio MCP consumes Hook input, keeps missing Docker unknown, deduplicates the same user request and reads after server restart", async () => temporary(async directory => {
  const f = await fixture(directory), env = { ...process.env, DEEPSEEK_API_KEY: "", MOONSHOT_API_KEY: "", PATH: dirname(process.execPath) };
  const connect = async () => { const client = new Client({ name: "synthetic-host-bridge-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("dist/mcp-entry.js"), "--data-dir", f.dataDir], env })); return client; };
  let client = await connect();
  try {
    for (const input of [{ externalPlanRef: f.plan.planRef, taskRef: f.capture.task.taskRef }, { externalPlanRef: f.plan.planRef, forceRerun: true }, { externalPlanRef: f.plan.planRef, verdict: "VERIFIED" }]) {
      let rejected = false; try { rejected = (await client.callTool({ name: "verify_task", arguments: input })).isError === true; } catch { rejected = true; } assert.ok(rejected);
    }
    const input = (await f.hook()).hookSpecificOutput!.updatedInput!;
    const request = unpack(await client.callTool({ name: "verify_task", arguments: input }));
    let final = request;
    for (let n = 0; n < 120 && final.status !== "completed"; n++) { await new Promise(resolve => setTimeout(resolve, 25)); final = unpack(await client.callTool({ name: "get_verification", arguments: { runId: request.runId, includeReport: true } })); }
    assert.equal(final.status, "completed"); assert.equal(final.verdict, "UNVERIFIABLE"); assert.equal(final.kind, "external-http-verification");
    assert.equal(final.captureCheck.acceptanceRequest.quote, "用 VibeGuard 验收"); assert.equal(final.coverage.counts.responseSteps, 0);
    assert.equal((await client.callTool({ name: "verify_task", arguments: input })).isError, true);
    const fresh = (await f.hook()).hookSpecificOutput!.updatedInput!;
    const repeat = unpack(await client.callTool({ name: "verify_task", arguments: fresh })); assert.equal(repeat.runId, request.runId); assert.equal(repeat.reused, true);
    assert.equal((await readdir(join(f.dataDir, "external-runs"))).length, 1);
    await client.close(); client = await connect();
    const restored = unpack(await client.callTool({ name: "get_verification", arguments: { runId: request.runId, includeReport: true } }));
    assert.equal(restored.verdict, "UNVERIFIABLE"); assert.equal(restored.externalRunRef, final.externalRunRef); assert.deepEqual(restored.captureCheck, final.captureCheck);
  } finally { await client.close(); }
}));
