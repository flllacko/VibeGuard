import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { prepareVerificationHook, verificationToolName } from "../capture-hook.js";
import { ConversationSchema, type Conversation } from "../intake.js";
import { VerifyTaskInputSchema } from "../mcp-contract.js";
import { createVibeGuardMcp } from "../mcp-server.js";
import { readRequirementReview, requirementReviewView } from "../requirement-review.js";
import type { RequirementGateway } from "../requirements.js";
import { registerTask } from "../task-registry.js";
import { VerificationService } from "../verification-service.js";
import { fixtureUnitCoverage } from "./fixture-unit-coverage.js";

const entryPath = fileURLToPath(new URL("../mcp-entry.js", import.meta.url));
type Result = Record<string, any>;

function originalConversation(): Conversation {
  return ConversationSchema.parse({
    schemaVersion: 1, taskId: "login-review", sessionId: randomUUID(), host: "codex-app-server",
    taskBoundary: { startMessageId: "u1", endMessageId: "a2" },
    transcriptCoverage: { level: "complete", source: "host_adapter", basis: "独立采集的完整测试会话；不代表真实宿主实测", missingMessageIds: [] },
    hostCapture: { allReturnedPagesRead: true, scopeOnlyGap: false, unparsedUserContent: [] },
    messages: [
      { id: "u1", sequence: 1, role: "user", text: "增加登录功能。" },
      { id: "a1", sequence: 2, role: "assistant", text: "开始实现登录。" },
      { id: "u2", sequence: 3, role: "user", text: "登录成功后跳转到首页。" },
      { id: "a2", sequence: 4, role: "assistant", text: "登录功能已经完成。" },
    ],
  });
}

function appendReply(source: Conversation, displayed: string, reply: string): Conversation {
  const current = structuredClone(source);
  const sequence = current.messages.at(-1)!.sequence;
  current.messages.push({ id: randomUUID(), sequence: sequence + 1, role: "assistant", text: displayed });
  current.messages.push({ id: randomUUID(), sequence: sequence + 2, role: "user", text: reply });
  current.taskBoundary.endMessageId = current.messages.at(-1)!.id;
  return current;
}

async function saveTask(dataDir: string, conversation: Conversation) {
  const path = join(dataDir, `${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(conversation, null, 2) + "\n");
  return registerTask(dataDir, path, "checkpoint");
}

function output(result: CallToolResult): Result {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.equal(typeof result.structuredContent, "object");
  return result.structuredContent as Result;
}

async function mustReject(action: () => Promise<CallToolResult>): Promise<void> {
  let rejected = false;
  try { rejected = (await action()).isError === true; } catch { rejected = true; }
  assert.equal(rejected, true, "Invalid host material or forged parameters must not be accepted");
}

async function connectFixture(dataDir: string) {
  let gatewayCalls = 0;
  const gateway: RequirementGateway = { async propose(input) {
    gatewayCalls++;
    assert.equal(gatewayCalls, 1, "Review corrections must not re-extract prior dialogue through a model");
    return { model: "fixture-no-network", proposal: fixtureUnitCoverage(input, {
      dispositions: [
        { messageId: "u1", kind: "requirements", reason: "用户直接要求登录" },
        { messageId: "u2", kind: "requirements", reason: "用户直接要求跳转" },
      ],
      events: [
        { action: "add", requirementId: "login", normalized: "增加登录功能", source: { messageId: "u1", quote: "增加登录功能。" } },
        { action: "add", requirementId: "redirect", normalized: "登录成功后跳转到首页", source: { messageId: "u2", quote: "登录成功后跳转到首页。" } },
      ],
    }) };
  } };
  const service = new VerificationService(dataDir, gateway, "fixture-no-network");
  const server = createVibeGuardMcp(service);
  const client = new Client({ name: "requirement-review-test-host", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, service, gatewayCalls: () => gatewayCalls };
}

async function verify(client: Client, service: VerificationService, args: Record<string, unknown>): Promise<Result> {
  const started = output(await client.callTool({ name: "verify_task", arguments: args }));
  await service.wait(started.runId);
  return output(await client.callTool({ name: "get_verification", arguments: { runId: started.runId } }));
}

async function cleanup(dataDir: string) {
  assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep));
  await rm(dataDir, { recursive: true, force: true });
}

test("MCP and fresh Hook capture support correcting then confirming original requirements, persisted across a new server process", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vibeguard-review-mcp-"));
  const host = await connectFixture(dataDir);
  let restarted: Client | undefined;
  try {
    assert.deepEqual((await host.client.listTools()).tools.map(tool => tool.name).sort(), ["get_verification", "read_evidence", "verify_task"]);
    const source = originalConversation();
    const original = await saveTask(dataDir, source);
    const initial = await verify(host.client, host.service, { taskRef: original.taskRef });
    assert.equal(initial.verdict, "UNVERIFIABLE");
    assert.equal(initial.gapStage, "requirements_review");
    assert.equal(initial.requirementReview.status, "awaiting_review");
    assert.deepEqual(initial.requirementReview.items.map((item: Result) => item.displayId), ["R1", "R2"]);
    assert.match(initial.requirementReview.text, /增加登录功能。/);
    assert.match(initial.requirementReview.text, /登录成功后跳转到首页。/);
    assert.equal(initial.requirementReview.planningEligible, false);

    const changedSource = appendReply(source, initial.requirementReview.text, "第2条改成：登录成功后跳转到个人中心。");
    let captureCalls = 0;
    const correctedInput = await prepareVerificationHook(JSON.stringify({
      hook_event_name: "PreToolUse", tool_name: verificationToolName, session_id: source.sessionId, cwd: process.cwd(),
      tool_input: { taskRef: original.taskRef, requirementReview: { reviewRef: initial.requirementReview.reviewRef } },
    }), { host: "codex", dataDir }, async session => {
      captureCalls++;
      assert.equal(session.sessionId, source.sessionId);
      assert.equal(session.cwd, process.cwd());
      return saveTask(dataDir, changedSource);
    });
    assert.equal(captureCalls, 1, "Explicit old taskRef must not bypass fresh review capture");
    assert.notEqual(correctedInput.hookSpecificOutput!.updatedInput!.taskRef, original.taskRef);
    const corrected = await verify(host.client, host.service, correctedInput.hookSpecificOutput!.updatedInput!);
    assert.equal(corrected.verdict, "UNVERIFIABLE");
    assert.equal(corrected.gapStage, "requirements_review");
    assert.equal(corrected.requirementReview.status, "awaiting_review");
    assert.notEqual(corrected.requirementReview.reviewRef, initial.requirementReview.reviewRef);
    assert.deepEqual(corrected.requirementReview.items.map((item: Result) => item.displayId), ["R1", "R2"]);
    assert.match(corrected.requirementReview.items[1].normalized, /个人中心/);
    assert.equal(corrected.requirementReview.items[1].sourceRefs.some((ref: Result) => ref.quote === changedSource.messages.at(-1)!.text), true);
    assert.equal(corrected.requirementReview.items[1].sourceRefs.some((ref: Result) => ref.quote === "登录成功后跳转到首页。"), true);
    assert.equal(corrected.requirementReview.planningEligible, false);

    const confirmedSource = appendReply(changedSource, corrected.requirementReview.text, "理解正确，开始验收");
    const confirmInput = await prepareVerificationHook(JSON.stringify({
      hook_event_name: "PreToolUse", tool_name: verificationToolName, session_id: source.sessionId, cwd: process.cwd(),
      tool_input: { taskRef: original.taskRef, requirementReview: { reviewRef: corrected.requirementReview.reviewRef } },
    }), { host: "codex", dataDir }, async () => { captureCalls++; return saveTask(dataDir, confirmedSource); });
    const confirmed = await verify(host.client, host.service, confirmInput.hookSpecificOutput!.updatedInput!);
    assert.equal(captureCalls, 2);
    assert.equal(host.gatewayCalls(), 1);
    assert.equal(confirmed.requirementReview.status, "confirmed");
    assert.equal(confirmed.requirementReview.planningEligible, true);
    assert.equal(confirmed.verdict, "UNVERIFIABLE", "Confirming interpretation cannot prove delivery completed");
    assert.equal(confirmed.gapStage, "execution");
    assert.deepEqual(confirmed.requirements.flatMap((item: Result) => item.evidenceIds), []);
    assert.equal(confirmed.requirements.every((item: Result) => item.verdict === "UNVERIFIABLE"), true);
    const stored = await readRequirementReview(dataDir, confirmed.requirementReview.reviewRef);
    assert.equal(stored.confirmation!.messageId, confirmedSource.messages.at(-1)!.id);
    assert.equal(requirementReviewView(stored).text, confirmed.requirementReview.text);
    await mustReject(() => host.client.callTool({ name: "read_evidence", arguments: { runId: confirmed.runId, evidenceId: randomUUID() } }));

    await host.client.close();
    await host.server.close();
    restarted = new Client({ name: "review-independent-observer", version: "1.0.0" });
    await restarted.connect(new StdioClientTransport({ command: process.execPath, args: [entryPath, "--data-dir", dataDir], stderr: "pipe" }));
    const reread = output(await restarted.callTool({ name: "get_verification", arguments: { runId: confirmed.runId, includeReport: true } }));
    assert.equal(reread.verdict, "UNVERIFIABLE");
    assert.equal(reread.gapStage, "execution");
    assert.deepEqual(reread.requirementReview, confirmed.requirementReview);
    assert.deepEqual(reread.requirements, confirmed.requirements);
  } finally {
    await restarted?.close();
    await host.client.close();
    await host.server.close();
    await cleanup(dataDir);
  }
});

test("MCP rejects cross-session, undisplayed, intervening and superseded review replies without calling the model again", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vibeguard-review-reject-"));
  const host = await connectFixture(dataDir);
  try {
    const source = originalConversation(), task = await saveTask(dataDir, source);
    const initial = await verify(host.client, host.service, { taskRef: task.taskRef });
    const selection = { reviewRef: initial.requirementReview.reviewRef };
    const wrongSession = appendReply(source, initial.requirementReview.text, "确认");
    wrongSession.sessionId = randomUUID();
    const undisplayed = appendReply(source, "请确认以上要求。", "确认");
    const multipleUsers = appendReply(source, initial.requirementReview.text, "还要支持短信登录。");
    multipleUsers.messages.push({ id: randomUUID(), sequence: multipleUsers.messages.at(-1)!.sequence + 1, role: "user", text: "确认" });
    multipleUsers.taskBoundary.endMessageId = multipleUsers.messages.at(-1)!.id;
    for (const invalid of [wrongSession, undisplayed, multipleUsers]) {
      const fresh = await saveTask(dataDir, invalid);
      await mustReject(() => host.client.callTool({ name: "verify_task", arguments: { taskRef: fresh.taskRef, requirementReview: selection } }));
    }
    const changedSource = appendReply(source, initial.requirementReview.text, "取消第2条");
    const fresh = await saveTask(dataDir, changedSource);
    const changed = await verify(host.client, host.service, { taskRef: fresh.taskRef, requirementReview: selection });
    assert.equal(changed.requirementReview.items[1].status, "cancelled");
    assert.equal(changed.requirements.length, 1);
    const alternative = await saveTask(dataDir, appendReply(source, initial.requirementReview.text, "确认"));
    await mustReject(() => host.client.callTool({ name: "verify_task", arguments: { taskRef: alternative.taskRef, requirementReview: selection } }));
    const duplicate = await verify(host.client, host.service, { taskRef: fresh.taskRef, requirementReview: selection });
    assert.equal(duplicate.runId, changed.runId, "Same captured reply must be idempotent");
    assert.equal(host.gatewayCalls(), 1);
  } finally { await host.client.close(); await host.server.close(); await cleanup(dataDir); }
});

test("an ambiguous user reply requests clarification and never confirms understanding or delivery", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vibeguard-review-clarify-"));
  const host = await connectFixture(dataDir);
  try {
    const source = originalConversation(), task = await saveTask(dataDir, source);
    const initial = await verify(host.client, host.service, { taskRef: task.taskRef });
    const vague = await saveTask(dataDir, appendReply(source, initial.requirementReview.text, "继续"));
    const result = await verify(host.client, host.service, { taskRef: vague.taskRef, requirementReview: { reviewRef: initial.requirementReview.reviewRef } });
    assert.equal(result.requirementReview.status, "needs_clarification");
    assert.equal(result.requirementReview.planningEligible, false);
    assert.equal(result.gapStage, "requirements_review");
    assert.equal(result.verdict, "UNVERIFIABLE");
    assert.equal(result.requirementReview.unresolved.some((question: Result) => !question.resolved && question.quote.includes("继续")), true);
    assert.deepEqual(result.requirements.flatMap((item: Result) => item.evidenceIds), []);
    assert.equal(host.gatewayCalls(), 1);
  } finally { await host.client.close(); await host.server.close(); await cleanup(dataDir); }
});

test("review MCP parameters cannot fabricate confirmation or verdict and cannot select scope simultaneously", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vibeguard-review-schema-"));
  const host = await connectFixture(dataDir);
  try {
    const taskRef = randomUUID(), reviewRef = randomUUID();
    const cases = [
      { taskRef, requirementReview: { reviewRef, confirmed: true } },
      { taskRef, requirementReview: { reviewRef, verdict: "VERIFIED" } },
      { taskRef, requirementReview: { reviewRef }, verdict: "VERIFIED" },
      { taskRef, requirementReview: { reviewRef }, taskSelection: { proposalRef: randomUUID(), candidateId: "S1" } },
    ];
    for (const args of cases) {
      assert.throws(() => VerifyTaskInputSchema.parse(args));
      await mustReject(() => host.client.callTool({ name: "verify_task", arguments: args }));
    }
    assert.equal(host.gatewayCalls(), 0);
  } finally { await host.client.close(); await host.server.close(); await cleanup(dataDir); }
});
