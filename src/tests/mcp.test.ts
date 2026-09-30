import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { registerTask, demoProfilePath } from "../task-registry.js";
import { makeManualDemoPlan } from "../demo-plan.js";
import { freezePlan } from "../planning.js";
import { saveResolution } from "../resolution-storage.js";
import { savePlanRecord } from "../plan-storage.js";
import { readApiProfile } from "../pi-plan-gateway.js";
import { profileHash } from "../plan-profile.js";

const serverPath = fileURLToPath(new URL("../mcp-entry.js", import.meta.url));
const conversationPath = fileURLToPath(new URL("../../fixtures/conversations/coupon-complete.json", import.meta.url));
const serverErrors = new WeakMap<Client, { text: string }>();

function payload(result: CallToolResult): Record<string, any> {
  assert.equal(result.isError, undefined);
  assert.equal(typeof result.structuredContent, "object");
  return result.structuredContent as Record<string, any>;
}

async function connect(dataDir: string): Promise<Client> {
  const client = new Client({ name: "vibeguard-test-host", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, "--data-dir", dataDir], stderr: "pipe" });
  const errors = { text: "" };
  serverErrors.set(client, errors);
  transport.stderr?.on("data", chunk => { errors.text += chunk.toString(); });
  await client.connect(transport);
  return client;
}

async function completed(client: Client, runId: string): Promise<Record<string, any>> {
  let last: Record<string, any> | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = payload(await client.callTool({ name: "get_verification", arguments: { runId } }));
    last = result;
    if (result.status === "completed") return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Verification did not complete within test timeout: ${JSON.stringify(last)}; ${serverErrors.get(client)?.text ?? ""}`);
}

async function mustReject(action: () => Promise<CallToolResult>): Promise<void> {
  let rejected = false;
  try { rejected = (await action()).isError === true; } catch { rejected = true; }
  assert.equal(rejected, true);
}

test("MCP stdio exposes only three tools, rejects verdict/path inputs and keeps incomplete material unverified", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vibeguard-mcp-material-"));
  let client: Client | undefined;
  try {
    const source = join(dataDir, "partial.json");
    await writeFile(source, JSON.stringify({ schemaVersion: 1, taskId: "partial", sessionId: "test", host: "fixture", taskBoundary: { startMessageId: "u1", endMessageId: "u1" }, transcriptCoverage: { level: "partial", source: "agent_summary", basis: "only a summary", missingMessageIds: [] }, messages: [{ id: "u1", sequence: 1, role: "user", text: "增加登录功能" }] }));
    const task = await registerTask(dataDir, source, "checkpoint");
    client = await connect(dataDir);
    assert.deepEqual((await client.listTools()).tools.map(item => item.name).sort(), ["get_verification", "read_evidence", "verify_task"]);
    await mustReject(() => client!.callTool({ name: "verify_task", arguments: { taskRef: task.taskRef, verdict: "VERIFIED" } }));
    await mustReject(() => client!.callTool({ name: "verify_task", arguments: { taskRef: "../../secrets" } }));
    const request = payload(await client.callTool({ name: "verify_task", arguments: { taskRef: task.taskRef } }));
    const result = await completed(client, request.runId);
    assert.equal(result.verdict, "UNVERIFIABLE");
    assert.equal(result.scope, "checkpoint");
    assert.equal(result.gapStage, "material");
    assert.match(result.issues.join(" "), /partial/);
    const repeat = payload(await client.callTool({ name: "verify_task", arguments: { taskRef: task.taskRef } }));
    assert.equal(repeat.runId, request.runId);
    assert.equal(repeat.reused, true);
    const rerun = payload(await client.callTool({ name: "verify_task", arguments: { taskRef: task.taskRef, forceRerun: true } }));
    assert.notEqual(rerun.runId, request.runId);
    await completed(client, rerun.runId);
    await mustReject(() => client!.callTool({ name: "read_evidence", arguments: { runId: request.runId, evidenceId: randomUUID() } }));
  } finally {
    await client?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("MCP controlled execution returns original quotes and real failure evidence, readable after server restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vibeguard-mcp-evidence-"));
  let client: Client | undefined;
  try {
    const demo = await makeManualDemoPlan();
    demo.resolution.resolutionId = randomUUID();
    const plan = freezePlan(demo.resolution, { criteria: demo.plan.criteria, coverage: demo.plan.coverage }, "manual-fixture");
    await saveResolution(demo.resolution, dataDir);
    await savePlanRecord(dataDir, { plan, generation: { model: "manual-fixture-not-real-model", promptHash: "manual", usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, profileId: "fixture", profileSha256: profileHash(await readApiProfile(demoProfilePath)) } });
    const faultyTask = await registerTask(dataDir, conversationPath, "final", { planHash: plan.planHash, variant: "faulty" });
    client = await connect(dataDir);
    const request = payload(await client.callTool({ name: "verify_task", arguments: { taskRef: faultyTask.taskRef } }));
    const result = await completed(client, request.runId);
    assert.equal(result.verdict, "FAILED");
    const threshold = result.requirements.find((item: any) => item.requirementId === "threshold");
    assert.equal(threshold.verdict, "FAILED");
    assert.equal(threshold.sourceRefs.some((ref: any) => ref.quote === "门槛改成满 150 元，其他规则不变。"), true);
    const evidenceId = threshold.evidenceIds.at(-1);
    const evidence = payload(await client.callTool({ name: "read_evidence", arguments: { runId: request.runId, evidenceId, limit: 8000 } }));
    assert.equal(evidence.truncated, false);
    const raw = JSON.parse(evidence.text);
    assert.equal(raw.response.body.amountCents, 14900);
    assert.equal(raw.response.body.discountCents, 2000);
    const snippet = payload(await client.callTool({ name: "read_evidence", arguments: { runId: request.runId, evidenceId, limit: 20 } }));
    assert.equal(snippet.truncated, true);
    assert.equal(snippet.text.length, 20);
    await mustReject(() => client!.callTool({ name: "read_evidence", arguments: { runId: request.runId, evidenceId: randomUUID() } }));
    await client.close();
    client = await connect(dataDir);
    const restored = payload(await client.callTool({ name: "get_verification", arguments: { runId: request.runId, includeReport: true } }));
    assert.equal(restored.verdict, "FAILED");
    assert.equal(restored.report.source, "manual-fixture");
    const reread = payload(await client.callTool({ name: "read_evidence", arguments: { runId: request.runId, evidenceId, limit: 8000 } }));
    assert.equal(reread.sha256, evidence.sha256);
    const evidencePath = join(dataDir, "planned-runs", restored.reportRef, `${evidenceId}.json`);
    await writeFile(evidencePath, "{}");
    await mustReject(() => client!.callTool({ name: "get_verification", arguments: { runId: request.runId } }));
  } finally {
    await client?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
