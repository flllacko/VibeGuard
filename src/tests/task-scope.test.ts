import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { ConversationSchema, inspectConversation, type Conversation } from "../intake.js";
import { readTask, registerTask } from "../task-registry.js";
import { proposeTaskScope, readSelectedScopeParent, readTaskIntake, scopeConfirmationReply, selectTaskScope, validateScopeProposal, type ScopeProposal, type TaskScopeGateway } from "../task-scope.js";
import { VerificationService } from "../verification-service.js";
import { fixtureUnitCoverage } from "./fixture-unit-coverage.js";
import { prepareVerificationHook, verificationToolName } from "../capture-hook.js";
import { VerifyTaskInputSchema } from "../mcp-contract.js";
import { requirementModelPayload } from "../pi-gateway.js";
import { indexScopeConversation, restoreScopeIds } from "../pi-scope-gateway.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createVibeGuardMcp } from "../mcp-server.js";

function conversation(): Conversation {
  return ConversationSchema.parse({ schemaVersion: 1, taskId: "mixed", sessionId: "session-1", host: "codex-app-server",
    taskBoundary: { startMessageId: "u0", endMessageId: "u3" },
    transcriptCoverage: { level: "partial", source: "host_adapter", basis: "范围未确认，旧任务有未解析图片", missingMessageIds: [] },
    hostCapture: { allReturnedPagesRead: true, scopeOnlyGap: true, unparsedUserContent: [{ messageId: "u0", count: 1 }] },
    messages: [
      { id: "u0", role: "user", text: "按这张图调整按钮。" }, { id: "a0", role: "assistant", text: "按钮已修改。" },
      { id: "u1", role: "user", text: "后续功能都要保留登录状态。" }, { id: "a1", role: "assistant", text: "会保留。" },
      { id: "u2", role: "user", text: "增加修改密码功能。" }, { id: "a2", role: "assistant", text: "已增加修改密码。" },
      { id: "u3", role: "user", text: "验收刚才这项任务。" },
    ].map((message, index) => ({ ...message, sequence: index + 1 })) });
}
const proposal = (): ScopeProposal => ({ candidates: [{ candidateId: "S1", title: "修改密码", startMessageId: "u2", endMessageId: "a2", contextMessageIds: ["u1", "a1"], sourceRefs: [{ messageId: "u2", quote: "增加修改密码功能。" }, { messageId: "u1", quote: "后续功能都要保留登录状态。" }], reason: "最近交付为修改密码；前文要求保留登录状态。" }], ambiguities: [] });
const scopeGateway: TaskScopeGateway = { policyId: "scope-fixture-v1", async propose() { return { proposal: proposal(), model: "fixture" }; } };
async function saveTask(directory: string, source: Conversation) {
  const path = join(directory, `${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(source, null, 2) + "\n");
  return registerTask(directory, path, "checkpoint");
}
function confirmed(parent: Conversation, reply = "验收范围 S1"): Conversation {
  const fresh = structuredClone(parent);
  fresh.messages.push({ id: "ask", sequence: fresh.messages.at(-1)!.sequence + 1, role: "assistant", text: "是否验收修改密码并带入登录限制？" });
  fresh.messages.push({ id: "choice", sequence: fresh.messages.at(-1)!.sequence + 1, role: "user", text: reply });
  fresh.taskBoundary.endMessageId = "choice";
  return fresh;
}
async function cleanup(directory: string) {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  await rm(directory, { recursive: true, force: true });
}

test("scope boundaries and verbatim user sources are validated; model cannot approve or invent a task", () => {
  const source = conversation();
  assert.equal(validateScopeProposal(proposal(), source).candidates.length, 1);
  for (const change of [
    (p: ScopeProposal) => { p.candidates[0]!.startMessageId = "a2"; },
    (p: ScopeProposal) => { p.candidates[0]!.sourceRefs[0]!.quote = "增加支付功能"; },
    (p: ScopeProposal) => { p.candidates[0]!.sourceRefs[0] = { messageId: "a2", quote: "已增加修改密码。" }; },
    (p: ScopeProposal) => { p.candidates[0]!.contextMessageIds = ["u3"]; },
    (p: ScopeProposal) => { p.candidates.push(structuredClone(p.candidates[0]!)); },
  ]) { const invalid = proposal(); change(invalid); assert.throws(() => validateScopeProposal(invalid, source)); }
  assert.throws(() => validateScopeProposal({ ...proposal(), verdict: "VERIFIED" }, source));
  assert.throws(() => VerifyTaskInputSchema.parse({ taskSelection: { proposalRef: randomUUID(), candidateId: "S1", confirmed: true } }));
});

test("a genuine later reply selects work plus prior constraints without changing original text or globally completing history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-scope-"));
  try {
    const source = conversation(), parent = await saveTask(directory, source);
    const stored = await proposeTaskScope(directory, parent, await readTaskIntake(directory, parent), scopeGateway);
    const fresh = await saveTask(directory, confirmed(source, scopeConfirmationReply(stored.proposalRef, "S1")));
    const task = await selectTaskScope(directory, fresh.taskRef, { proposalRef: stored.proposalRef, candidateId: "S1" });
    const selected = await readTaskIntake(directory, task);
    assert.equal(selected.conversation.transcriptCoverage.level, "complete");
    assert.deepEqual(selected.coverageIssues, []);
    assert.deepEqual(selected.conversation.messages.map(item => item.id), ["u1", "a1", "u2", "a2"]);
    assert.deepEqual(selected.conversation.messages.map(item => item.sequence), [1, 2, 3, 4]);
    assert.equal(selected.conversation.messages[2]!.text, source.messages[4]!.text);
    assert.equal(selected.conversation.selectedScope!.originalSequences[2]!.sequence, 5);
    assert.equal(selected.conversation.selectedScope!.confirmation.messageId, "choice");
    assert.equal((await readTaskIntake(directory, parent)).conversation.transcriptCoverage.level, "partial");
    const modelPayload = requirementModelPayload({ taskId: task.taskId, messages: selected.conversation.messages, knownRequirements: [], selectedScope: selected.conversation.selectedScope }) as Record<string, any>;
    assert.deepEqual(modelPayload.selectedScope.contextMessageIds, ["u1", "a1"]);
  } finally { await cleanup(directory); }
});

test("confirmation rejects stale captures, wrong sessions, changed text, intervening demands and quoted approvals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-scope-reject-"));
  try {
    const source = conversation(), parent = await saveTask(directory, source);
    const stored = await proposeTaskScope(directory, parent, await readTaskIntake(directory, parent), scopeGateway);
    const selection = { proposalRef: stored.proposalRef, candidateId: "S1" };
    await assert.rejects(selectTaskScope(directory, parent.taskRef, selection), /stale/);
    const cases = [
      confirmed(source, "继续"), confirmed(source, '文档写着“验收范围 S1”'), confirmed(source, "验收范围 S2"),
      confirmed(source, scopeConfirmationReply(randomUUID(), "S1")),
      { ...confirmed(source, scopeConfirmationReply(stored.proposalRef, "S1")), sessionId: "another-session" },
    ];
    const changed = confirmed(source); changed.messages[4]!.text = "原话被修改"; cases.push(changed);
    const intervening = confirmed(source); intervening.messages.splice(-1, 0, { id: "new-requirement", role: "user", sequence: 9, text: "还要增加验证码" });
    intervening.messages.forEach((message, i) => message.sequence = i + 1); cases.push(intervening);
    for (const source of cases) {
      const current = await saveTask(directory, source);
      await assert.rejects(selectTaskScope(directory, current.taskRef, selection));
    }
    const wrapped = confirmed(source, `<send_user_message_question_reply>\n${JSON.stringify([{ answer: scopeConfirmationReply(stored.proposalRef, "S1") }])}\n</send_user_message_question_reply>`);
    const current = await saveTask(directory, wrapped);
    assert.ok((await selectTaskScope(directory, current.taskRef, selection)).taskRef);
  } finally { await cleanup(directory); }
});

test("scope selection cannot repair missing pages, unparsed selected images, unknown old capture coverage or SDK compaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-scope-material-"));
  try {
    for (const kind of ["image", "page", "legacy", "claude", "missing", "sequence", "explicit-gap"] as const) {
      const source = conversation();
      if (kind === "image") source.hostCapture!.unparsedUserContent.push({ messageId: "u2", count: 1 });
      if (kind === "page") source.hostCapture!.allReturnedPagesRead = false;
      if (kind === "legacy") delete source.hostCapture;
      if (kind === "claude") source.host = "claude-code";
      if (kind === "missing") source.transcriptCoverage.missingMessageIds = ["missing-user"];
      if (kind === "sequence") source.messages.forEach(message => message.sequence += 1);
      if (kind === "explicit-gap") source.materialGaps = [{ kind: "history_coverage_unknown", messageIds: [], detail: "已知仍有未取得的历史记录。" }];
      const parent = await saveTask(directory, source);
      const stored = await proposeTaskScope(directory, parent, await readTaskIntake(directory, parent), scopeGateway);
      const fresh = confirmed(source, scopeConfirmationReply(stored.proposalRef, "S1"));
      // A fresh complete capture can prove the reply while the old parent
      // retains its material gap. An invalid parent sequence cannot form a
      // structurally complete confirmation with the same original prefix.
      if (kind === "page") fresh.hostCapture!.allReturnedPagesRead = true;
      if (kind === "missing") fresh.transcriptCoverage.missingMessageIds = [];
      const current = await saveTask(directory, fresh);
      if (kind === "sequence") {
        await assert.rejects(selectTaskScope(directory, current.taskRef, { proposalRef: stored.proposalRef, candidateId: "S1" }), /structural gaps/);
        continue;
      }
      const selected = await readTaskIntake(directory, await selectTaskScope(directory, current.taskRef, { proposalRef: stored.proposalRef, candidateId: "S1" }));
      assert.equal(selected.conversation.transcriptCoverage.level, "partial", kind);
      assert.ok(inspectConversation(selected.conversation).coverageIssues.length, kind);
      assert.doesNotMatch(selected.conversation.transcriptCoverage.basis, /尚未确认|范围未确认/);
      assert.ok(selected.conversation.materialGaps!.length, kind);
      if (kind === "image") assert.deepEqual(selected.conversation.materialGaps![0], { kind: "unparsed_user_content", messageIds: ["u2"], count: 1, detail: "所选正文或带入前文中有 1 项未解析的非文字用户内容。" });
    }
  } finally { await cleanup(directory); }
});

test("scope confirmation rejects incomplete new captures and non-text additions to the choice itself", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-scope-confirmation-material-"));
  try {
    const source = conversation(), parent = await saveTask(directory, source);
    const stored = await proposeTaskScope(directory, parent, await readTaskIntake(directory, parent), scopeGateway);
    const selection = { proposalRef: stored.proposalRef, candidateId: "S1" };
    for (const kind of ["sequence", "boundary", "missing-message", "unread-page", "choice-image", "choice-gap"] as const) {
      const fresh = confirmed(source, scopeConfirmationReply(stored.proposalRef, "S1"));
      if (kind === "sequence") fresh.messages.at(-1)!.sequence += 1;
      if (kind === "boundary") fresh.taskBoundary.endMessageId = "not-the-last-message";
      if (kind === "missing-message") fresh.transcriptCoverage.missingMessageIds = ["possibly-new-demand"];
      if (kind === "unread-page") fresh.hostCapture!.allReturnedPagesRead = false;
      if (kind === "choice-image") fresh.hostCapture!.unparsedUserContent.push({ messageId: "choice", count: 1 });
      if (kind === "choice-gap") fresh.materialGaps = [{ kind: "unparsed_user_content", messageIds: ["choice"], count: 1, detail: "确认回复还附有未解析图片。" }];
      const current = await saveTask(directory, fresh);
      await assert.rejects(selectTaskScope(directory, current.taskRef, selection), /structural gaps|missing messages|unread pages|unparsed user content/, kind);
    }
  } finally { await cleanup(directory); }
});

test("a legacy confirmation without a non-text ledger keeps a scope choice but cannot establish usable material", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-scope-legacy-confirmation-"));
  try {
    const source = conversation(), parent = await saveTask(directory, source);
    const stored = await proposeTaskScope(directory, parent, await readTaskIntake(directory, parent), scopeGateway);
    const fresh = confirmed(source, scopeConfirmationReply(stored.proposalRef, "S1"));
    delete fresh.hostCapture;
    const current = await saveTask(directory, fresh);
    const selected = await readTaskIntake(directory, await selectTaskScope(directory, current.taskRef, { proposalRef: stored.proposalRef, candidateId: "S1" }));
    assert.equal(selected.conversation.selectedScope!.confirmation.messageId, "choice");
    assert.equal(selected.conversation.transcriptCoverage.level, "partial");
    assert.ok(selected.conversation.materialGaps!.some(gap => gap.kind === "history_coverage_unknown"));
    await assert.rejects(readSelectedScopeParent(directory, selected.conversation), /Legacy scope confirmation/);
  } finally { await cleanup(directory); }
});

test("service asks for range before extracting requirements; confirmed extraction remains unverified without execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-scope-service-"));
  let requirementCalls = 0;
  const service = new VerificationService(directory, { async propose(input) {
    requirementCalls++;
    assert.deepEqual(input.selectedScope?.workMessageIds, ["u2", "a2"]);
    assert.deepEqual(input.messages.map(item => item.id), ["u1", "a1", "u2", "a2"]);
    return { model: "fixture", proposal: fixtureUnitCoverage(input, { dispositions: [{ messageId: "u1", kind: "requirements", reason: "仍有效的约束" }, { messageId: "u2", kind: "requirements", reason: "本次任务" }], events: [
      { action: "add", requirementId: "keep-login", normalized: "修改密码保留登录状态", source: { messageId: "u1", quote: "后续功能都要保留登录状态。" } },
      { action: "add", requirementId: "password", normalized: "增加修改密码功能", source: { messageId: "u2", quote: "增加修改密码功能。" } },
    ] }) };
  } }, "fixture", scopeGateway);
  try {
    const source = conversation(), parent = await saveTask(directory, source);
    const pending = await service.request(parent.taskRef);
    const review = await service.wait(pending.runId as string) as Record<string, any>;
    assert.equal(review.gapStage, "scope"); assert.equal(review.verdict, "UNVERIFIABLE"); assert.equal(requirementCalls, 0);
    assert.equal(review.taskScopeReview.candidates[0].confirmationReply, scopeConfirmationReply(review.taskScopeReview.proposalRef, "S1"));
    const current = await saveTask(directory, confirmed(source, review.taskScopeReview.candidates[0].confirmationReply));
    const run = await service.request(current.taskRef, false, { proposalRef: review.taskScopeReview.proposalRef, candidateId: "S1" });
    const result = await service.wait(run.runId as string) as Record<string, any>;
    assert.equal(requirementCalls, 1); assert.equal(result.gapStage, "requirements_review"); assert.equal(result.verdict, "UNVERIFIABLE");
    assert.equal(result.requirementReview.status, "awaiting_review");
    assert.equal(result.requirements.length, 2); assert.equal(result.selectedScope.title, "修改密码");
    assert.deepEqual(result.requirements.flatMap((item: any) => item.evidenceIds), []);
  } finally { await cleanup(directory); }
});

test("range confirmation forces a fresh Hook capture even if Agent supplies an existing task reference", async () => {
  const fresh = randomUUID(), prior = randomUUID(), selection = { proposalRef: randomUUID(), candidateId: "S1" };
  let calls = 0;
  const result = await prepareVerificationHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: verificationToolName, session_id: randomUUID(), cwd: process.cwd(), tool_input: { taskRef: prior, taskSelection: selection } }), { host: "codex", dataDir: process.cwd() }, async () => { calls++; return { taskRef: fresh }; });
  assert.equal(calls, 1); assert.equal(result.hookSpecificOutput!.updatedInput!.taskRef, fresh);
  assert.deepEqual(result.hookSpecificOutput!.updatedInput!.taskSelection, selection);
});

test("short model indices restore original message IDs and text, without accepting IDs embedded in quoted text", () => {
  const source = conversation();
  const indexed = indexScopeConversation(source);
  assert.deepEqual(indexed.conversation.messages.map(item => item.text), source.messages.map(item => item.text));
  const candidate = proposal().candidates[0]!;
  const short = { candidates: [{ ...candidate, startMessageId: "M5", endMessageId: "M6", contextMessageIds: ["M3", "M4"], sourceRefs: [{ messageId: "M5", quote: "增加修改密码功能。" }, { messageId: "M3", quote: "后续功能都要保留登录状态。" }] }], ambiguities: [] };
  assert.deepEqual(restoreScopeIds(short, indexed.originalIds, source), proposal());
  short.candidates[0]!.startMessageId = "message-id-pasted-in-text";
  assert.throws(() => restoreScopeIds(short, indexed.originalIds, source), /Unknown scope message index/);
});

test("identical captured material reuses scope proposals; policy changes invalidate the cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-scope-cache-"));
  let calls = 0;
  const gateway: TaskScopeGateway = { policyId: "cached-v1", async propose() { calls++; return { proposal: proposal(), model: "fixture" }; } };
  try {
    const source = conversation(), first = await saveTask(directory, source), second = await saveTask(directory, source);
    const a = await proposeTaskScope(directory, first, await readTaskIntake(directory, first), gateway);
    const b = await proposeTaskScope(directory, second, await readTaskIntake(directory, second), gateway);
    assert.equal(a.proposalRef, b.proposalRef); assert.equal(calls, 1);
    const c = await proposeTaskScope(directory, second, await readTaskIntake(directory, second), { ...gateway, policyId: "cached-v2" });
    assert.notEqual(c.proposalRef, a.proposalRef); assert.equal(calls, 2);
  } finally { await cleanup(directory); }
});

test("MCP range review and Hook-fed confirmation persist a material gap and can be read by a restarted service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-scope-mcp-"));
  const gateway = { async propose(): Promise<never> { throw new Error("Unparsed task images must block requirement extraction"); } };
  const service = new VerificationService(directory, gateway, "fixture", scopeGateway);
  const server = createVibeGuardMcp(service);
  const client = new Client({ name: "scope-review-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const source = conversation(); source.hostCapture!.unparsedUserContent.push({ messageId: "u2", count: 1 });
    const parent = await saveTask(directory, source);
    const first = await client.callTool({ name: "verify_task", arguments: { taskRef: parent.taskRef } });
    assert.equal(first.isError, undefined);
    const review = await service.wait((first.structuredContent as Record<string, unknown>).runId as string) as Record<string, any>;
    const selection = { proposalRef: review.taskScopeReview.proposalRef, candidateId: "S1" };
    const current = await saveTask(directory, confirmed(source, review.taskScopeReview.candidates[0].confirmationReply));
    const output = await prepareVerificationHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: verificationToolName, session_id: randomUUID(), cwd: process.cwd(), tool_input: { taskRef: parent.taskRef, taskSelection: selection } }), { host: "codex", dataDir: directory }, async () => ({ taskRef: current.taskRef }));
    const next = await client.callTool({ name: "verify_task", arguments: output.hookSpecificOutput!.updatedInput! });
    assert.equal(next.isError, undefined);
    const result = await service.wait((next.structuredContent as Record<string, unknown>).runId as string);
    assert.equal(result.gapStage, "material"); assert.equal(result.verdict, "UNVERIFIABLE");
    const restarted = new VerificationService(directory, gateway, "fixture", scopeGateway);
    const reread = await restarted.get(result.runId as string);
    assert.equal((reread.selectedScope as any).confirmation.messageId, "choice");
    assert.equal((reread.materialGaps as any[])[0].messageIds[0], "u2");
    assert.match(reread.nextStep as string, /范围已经确认，无须再次选择/);
    assert.deepEqual(reread.missingEvidence, ["所选正文或带入前文中有 1 项未解析的非文字用户内容。"]);
    assert.equal((await readTask(directory, result.taskRef as string)).execution.kind, "requirements_only");
    const forged = await client.callTool({ name: "verify_task", arguments: { taskRef: current.taskRef, taskSelection: { ...selection, confirmed: true } } }).catch(() => ({ isError: true }));
    assert.equal(forged.isError, true);
  } finally { await client.close(); await server.close(); await cleanup(directory); }
});

test("explicit material gaps cannot be overridden by a complete flag", () => {
  const source = conversation();
  source.transcriptCoverage.level = "complete";
  source.materialGaps = [{ kind: "unparsed_user_content", messageIds: ["u0"], count: 1, detail: "此图片尚未解析" }];
  assert.ok(inspectConversation(source).coverageIssues.includes("此图片尚未解析"));
});
