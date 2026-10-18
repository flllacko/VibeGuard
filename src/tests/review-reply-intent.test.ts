import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ConversationSchema, type Conversation, type ConversationMessage } from "../intake.js";
import { intentUnits } from "../intent-units.js";
import { createVibeGuardMcp } from "../mcp-server.js";
import { saveResolution } from "../resolution-storage.js";
import { applyRequirementReviewReply, createRequirementReview, readRequirementReview, requirementReviewView } from "../requirement-review.js";
import { registerTask } from "../task-registry.js";
import { VerificationService } from "../verification-service.js";
import type { Resolution } from "../requirements.js";
import { applyReviewReplyProposal, reviewReplyInput, type ReviewReplyGateway, type ReviewReplyProposal } from "../review-reply-intent.js";

async function temporary(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-semantic-review-"));
  try { await action(directory); } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
}
async function register(dataDir: string, conversation: Conversation) {
  const path = join(dataDir, `${randomUUID()}.json`); await writeFile(path, JSON.stringify(conversation));
  return registerTask(dataDir, path);
}
async function fixture(dataDir: string, goals = ["订单满150优惠20元。", "同一张券最多使用一次。", "退款后恢复优惠券。"], question = false) {
  const conversation = ConversationSchema.parse({ schemaVersion: 1, taskId: randomUUID(), sessionId: randomUUID(), host: "codex-app-server",
    transcriptCoverage: { level: "complete", source: "host_adapter", basis: "人工合成夹具，不代表真人或模型准确率", missingMessageIds: [] },
    hostCapture: { allReturnedPagesRead: true, scopeOnlyGap: false, unparsedUserContent: [] },
    taskBoundary: { startMessageId: "u1", endMessageId: `u${goals.length}` },
    messages: goals.map((text, index) => ({ id: `u${index + 1}`, sequence: index + 1, role: "user", text })),
  });
  const task = await register(dataDir, conversation);
  const resolution: Resolution = { schemaVersion: 1, resolutionId: randomUUID(), taskId: conversation.taskId, createdAt: new Date().toISOString(), conversationSha256: task.conversationSha256,
    transcriptCoverage: conversation.transcriptCoverage, coverageIssues: question ? ["存在尚未解释的用户原文片段"] : [],
    revisions: conversation.messages.filter((_, index) => !question || index !== goals.length - 1).map((message, index) => ({ requirementId: `goal-${index + 1}`, revision: 1, status: "active", normalized: message.text,
      sourceKind: "explicit_user", sourceRefs: [{ messageId: message.id, start: 0, end: message.text.length, quote: message.text }] })),
    dispositions: conversation.messages.map((message, index) => ({ messageId: message.id, kind: question && index === goals.length - 1 ? "unresolved" : "requirements", reason: "人工标注" })),
    interpretedUnits: intentUnits(conversation.messages).map((unit, index) => ({ ...unit, kind: question && index === goals.length - 1 ? "unresolved" : "requirement", requirementIds: question && index === goals.length - 1 ? [] : [`goal-${index + 1}`], reason: "人工标注" })),
    processing: [{ chunk: 1, messageIds: conversation.messages.map(message => message.id), status: "processed", model: "fixture" }], unprocessedUserMessageIds: [], resolutionComplete: !question,
  };
  await saveResolution(resolution, dataDir);
  return { conversation, task, review: await createRequirementReview(dataDir, task.taskRef, resolution.resolutionId) };
}
async function freshReply(dataDir: string, parent: Conversation, text: string, review: Awaited<ReturnType<typeof createRequirementReview>>) {
  const conversation = structuredClone(parent);
  conversation.messages.push({ id: randomUUID(), sequence: conversation.messages.length + 1, role: "assistant", text: requirementReviewView(review).text });
  const reply: ConversationMessage = { id: randomUUID(), sequence: conversation.messages.length + 1, role: "user", text };
  conversation.messages.push(reply); conversation.taskBoundary.endMessageId = reply.id;
  return { conversation, reply, task: await register(dataDir, conversation) };
}
function annotated(answer: string, operations: ReviewReplyProposal["operations"], confirmation?: string): ReviewReplyProposal {
  const ranges = operations.map(operation => ({ start: answer.indexOf(operation.source.quote), end: answer.indexOf(operation.source.quote) + operation.source.quote.length }));
  const confirmationRange = confirmation ? { start: answer.indexOf(confirmation), end: answer.indexOf(confirmation) + confirmation.length } : undefined;
  return { operations, ...(confirmation ? { confirmation: { quote: confirmation } } : {}), units: intentUnits([{ id: "reply", sequence: 1, role: "user", text: answer }]).map(unit => {
    const indexes = ranges.flatMap((range, index) => range.start < unit.end && unit.start < range.end ? [index] : []);
    return { unitId: unit.unitId, kind: indexes.length ? "operation" : confirmationRange && confirmationRange.start < unit.end && unit.start < confirmationRange.end ? "confirmation" : "context", operationIndexes: indexes, reason: "固定模型候选夹具，仅检查系统执行及约束，不评价语义识别" };
  }) };
}

test("natural review replies use a model proposal and preserve sources, changes, cost and restart replay without another call", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir);
  const answer = "优惠门槛还是按一百二十吧，减免换成十五，退款恢复那部分先放一边。";
  const proposal = annotated(answer, [
    { action: "replace", target: "R1", normalized: "订单满120元优惠15元", source: { quote: "优惠门槛还是按一百二十吧，减免换成十五" } },
    { action: "cancel", target: "R3", source: { quote: "退款恢复那部分先放一边" } },
  ]);
  let calls = 0;
  const gateway: ReviewReplyGateway = { policyId: "semantic-fixture", async propose(input) {
    calls++; assert.equal(input.answer, answer); assert.equal(input.requirements[2]!.displayId, "R3");
    assert.equal("messages" in input, false); assert.equal("materialIssues" in input, false);
    return { model: "mock-not-a-real-model-evaluation", proposal, usage: { inputTokens: 300, outputTokens: 200, estimatedCostUsd: 0 } };
  } };
  const current = await freshReply(dataDir, initial.conversation, answer, initial.review);
  const changed = await applyRequirementReviewReply(dataDir, current.task.taskRef, { reviewRef: initial.review.reviewRef }, gateway);
  assert.equal(changed.items[0]!.normalized, "订单满120元优惠15元"); assert.equal(changed.items[2]!.status, "cancelled");
  assert.equal(changed.status, "awaiting_review"); assert.equal(changed.confirmation, undefined); assert.equal(changed.interpretation?.mode, "model");
  assert.ok(changed.items[0]!.sourceRefs.some(source => source.quote === answer));
  assert.deepEqual(await readRequirementReview(dataDir, changed.reviewRef), changed);
  assert.equal((await applyRequirementReviewReply(dataDir, current.task.taskRef, { reviewRef: initial.review.reviewRef }, gateway)).reviewRef, changed.reviewRef);
  const confirm = await freshReply(dataDir, current.conversation, "确认", changed);
  assert.equal((await applyRequirementReviewReply(dataDir, confirm.task.taskRef, { reviewRef: changed.reviewRef }, gateway)).status, "confirmed");
  assert.equal(calls, 1);
}));

test("domain-neutral actions support semantic exclusion, addition, merge, restore and questions without business-specific parsing", async () => temporary(async dataDir => {
  const variants: { goals: string[]; answer: string; operations: ReviewReplyProposal["operations"]; check: (result: ReturnType<typeof applyReviewReplyProposal>) => void }[] = [
    { goals: ["支持密码登录。", "允许注册。"], answer: "密码登录换成短信验证码吧，另外记得登录后回到刚才的页面。", operations: [
      { action: "replace", target: "R1", normalized: "支持短信验证码登录", source: { quote: "密码登录换成短信验证码吧" } },
      { action: "add", normalized: "登录后返回登录前访问的页面", source: { quote: "另外记得登录后回到刚才的页面" } },
    ], check: result => { assert.match(result.items[0]!.normalized, /短信/); assert.equal(result.items[2]!.displayId, "R3"); } },
    { goals: ["按地区分组导出。", "导出地区合计。"], answer: "分组和合计可以算成一项，就叫按地区导出汇总。", operations: [
      { action: "merge", targets: ["R1", "R2"], normalized: "按地区导出汇总，包含地区分组和地区合计", source: { quote: "分组和合计可以算成一项，就叫按地区导出汇总" } },
    ], check: result => { assert.equal(result.items[1]!.status, "cancelled"); assert.equal(result.items[0]!.sourceRefs.length, 3); } },
  ];
  for (const variant of variants) {
    const initial = await fixture(dataDir, variant.goals), current = await freshReply(dataDir, initial.conversation, variant.answer, initial.review);
    const result = applyReviewReplyProposal(initial.review, current.reply, variant.answer, annotated(variant.answer, variant.operations));
    variant.check(result); assert.equal(result.status, "awaiting_review");
  }
  const initial = await fixture(dataDir, undefined, true), answer = "不用把退款那个问题算成这次要做的事。";
  const current = await freshReply(dataDir, initial.conversation, answer, initial.review);
  const result = applyReviewReplyProposal(initial.review, current.reply, answer, annotated(answer, [{ action: "clarify", target: "Q1", disposition: "context", source: { quote: "不用把退款那个问题算成这次要做的事" } }]));
  assert.equal(result.unresolved[0]!.resolved, true); assert.equal(result.status, "awaiting_review");
  const cancelAnswer = "同券重复使用这项暂时不验。", restoreAnswer = "把同券重复使用检查也恢复吧。";
  const cancelled = applyReviewReplyProposal(initial.review, { ...current.reply, text: cancelAnswer }, cancelAnswer, annotated(cancelAnswer, [{ action: "cancel", target: "R2", source: { quote: cancelAnswer } }]));
  const restored = applyReviewReplyProposal({ ...initial.review, ...cancelled }, { ...current.reply, text: restoreAnswer }, restoreAnswer, annotated(restoreAnswer, [{ action: "restore", target: "R2", source: { quote: restoreAnswer } }]));
  assert.equal(restored.items[1]!.status, "active");
}));

test("unsupported sources, targets, missing coverage, conflicting operations and model verdicts reject the entire candidate", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir), answer = "门槛用120，退款先不做。", current = await freshReply(dataDir, initial.conversation, answer, initial.review);
  const valid = annotated(answer, [
    { action: "replace", target: "R1", normalized: "满120优惠20", source: { quote: "门槛用120" } },
    { action: "cancel", target: "R3", source: { quote: "退款先不做" } },
  ]);
  const invalid: unknown[] = [];
  const omitted = structuredClone(valid); omitted.units.pop(); invalid.push(omitted);
  const quote = structuredClone(valid); quote.operations[0]!.source.quote = "这句话不在用户回复"; invalid.push(quote);
  const target = structuredClone(valid); (target.operations[0] as { target: string }).target = "R999"; invalid.push(target);
  invalid.push({ ...valid, verdict: "VERIFIED" });
  const conflict = structuredClone(valid); conflict.operations.push({ action: "cancel", target: "R1", source: { quote: "门槛用120" } }); conflict.units[0]!.operationIndexes.push(2); invalid.push(conflict);
  for (const candidate of invalid) assert.throws(() => applyReviewReplyProposal(initial.review, current.reply, answer, candidate));
  let calls = 0;
  const result = await applyRequirementReviewReply(dataDir, current.task.taskRef, { reviewRef: initial.review.reviewRef }, { policyId: "reject-fixture", async propose() { calls++; return { model: "mock", proposal: target }; } });
  assert.equal(result.status, "needs_clarification"); assert.deepEqual(result.items, initial.review.items);
  assert.equal(result.interpretation?.mode, "unavailable"); assert.equal(calls, 2);
}));

test("unclear natural replies remain questions and quoted assistant selections cannot supply modification evidence", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir), answer = "那个先不要，另外一个按之前的来。", current = await freshReply(dataDir, initial.conversation, answer, initial.review);
  const proposal: ReviewReplyProposal = { operations: [], units: intentUnits([{ id: "reply", sequence: 1, role: "user", text: answer }]).map(unit => ({ unitId: unit.unitId, kind: "unresolved", operationIndexes: [], reason: "请明确指的是退款还是重复用券。" })) };
  const result = applyReviewReplyProposal(initial.review, current.reply, answer, proposal);
  assert.equal(result.status, "needs_clarification"); assert.deepEqual(result.items, initial.review.items);
  const annotatedReply = '<response-annotations>\n[{"text":"取消退款验收","annotation":"我还没决定"}]\n</response-annotations>';
  const cited = annotated(annotatedReply, [{ action: "cancel", target: "R3", source: { quote: "取消退款验收" } }]);
  assert.throws(() => applyReviewReplyProposal(initial.review, { ...current.reply, text: annotatedReply }, annotatedReply, cited), /助手或第三方/);
}));

test("MCP uses the semantic gateway and never turns natural-language approval into completed work", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir), answer = "退款恢复那块这次先放下，另外两项按你理解的查。";
  let calls = 0;
  const gateway: ReviewReplyGateway = { policyId: "natural-mcp-fixture", async propose() { calls++; return { model: "mock", proposal: annotated(answer, [
    { action: "cancel", target: "R3", source: { quote: "退款恢复那块这次先放下" } },
  ], "另外两项按你理解的查") }; } };
  const service = new VerificationService(dataDir, { async propose() { throw new Error("Review must not re-extract the history"); } }, "fixture", undefined, gateway);
  const server = createVibeGuardMcp(service), client = new Client({ name: "semantic-review-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const current = await freshReply(dataDir, initial.conversation, answer, initial.review);
    const output = await client.callTool({ name: "verify_task", arguments: { taskRef: current.task.taskRef, requirementReview: { reviewRef: initial.review.reviewRef } } });
    assert.equal(output.isError, undefined, JSON.stringify(output.content));
    const result = output.structuredContent as Record<string, any>;
    assert.equal(result.requirementReview.status, "awaiting_review"); assert.equal(result.verdict, "UNVERIFIABLE");
    assert.ok(result.requirements.every((item: any) => item.evidenceIds.length === 0));
    assert.equal(calls, 1);
    assert.deepEqual(await new VerificationService(dataDir, { async propose() { throw new Error("No calls on reread"); } }, "observer").get(result.runId), await service.get(result.runId));
  } finally { await client.close(); await server.close(); }
}));

test("provider failure preserves the reply without changes, and persisted interpretation is checked without a live model", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir), current = await freshReply(dataDir, initial.conversation, "登录那项改成短信方式吧。", initial.review);
  const unavailable = await applyRequirementReviewReply(dataDir, current.task.taskRef, { reviewRef: initial.review.reviewRef }, { policyId: "offline", async propose() { throw new Error("API unavailable"); } });
  assert.deepEqual(unavailable.items, initial.review.items); assert.equal(unavailable.status, "needs_clarification");
  assert.match(requirementReviewView(unavailable).text, /尚未应用任何修改/);
  const stored = JSON.parse(await readFile(join(dataDir, "requirement-reviews", `${unavailable.reviewRef}.json`), "utf8"));
  stored.interpretation.reason = "伪造解释"; await writeFile(join(dataDir, "requirement-reviews", `${unavailable.reviewRef}.json`), JSON.stringify(stored));
  await assert.rejects(readRequirementReview(dataDir, unavailable.reviewRef), /hash mismatch/);
}));

test("a candidate gets at most one validation-feedback repair, with original input and accumulated usage preserved", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir), answer = "优惠门槛就设为120元。", current = await freshReply(dataDir, initial.conversation, answer, initial.review);
  let calls = 0;
  const result = await applyRequirementReviewReply(dataDir, current.task.taskRef, { reviewRef: initial.review.reviewRef }, {
    policyId: "bounded-repair-fixture", async propose(input, feedback) {
      calls++; assert.equal(input.answer, answer);
      if (calls === 1) assert.equal(feedback, undefined); else assert.match(feedback!, /编号或当前状态/);
      return { model: "mock", proposal: annotated(answer, [{ action: "replace", target: calls === 1 ? "R999" : "R1", normalized: "满120元优惠20元", source: { quote: answer } }]),
        usage: { inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 } };
    },
  });
  assert.equal(calls, 2); assert.equal(result.status, "awaiting_review"); assert.equal(result.items[0]!.normalized, "满120元优惠20元");
  assert.equal(result.interpretation!.mode, "model");
  if (result.interpretation!.mode === "model") {
    assert.deepEqual(result.interpretation!.attempts?.map(attempt => attempt.status), ["rejected", "accepted"]);
    assert.equal(result.interpretation!.usage?.inputTokens, 200); assert.equal(result.interpretation!.usage?.estimatedCostUsd, 0.002);
  }
  assert.deepEqual(await readRequirementReview(dataDir, result.reviewRef), result);
}));

test("missing empty operation indexes are harmless for context or questions, but cannot create an operation", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir), answer = "先不要开始。", current = await freshReply(dataDir, initial.conversation, answer, initial.review);
  const withoutIndexes = { operations: [], units: [{ unitId: "u1.1", kind: "context", reason: "明确暂缓，并未改变清单。" }] };
  const result = applyReviewReplyProposal(initial.review, current.reply, answer, withoutIndexes);
  assert.equal(result.status, "awaiting_review"); assert.deepEqual(result.items, initial.review.items);
  assert.throws(() => applyReviewReplyProposal(initial.review, current.reply, answer, { operations: [{ action: "cancel", target: "R1", source: { quote: answer } }],
    units: [{ unitId: "u1.1", kind: "operation", reason: "不能用缺省空数组伪造修改来源关联。" }] }), /修改片段没有关联操作/);
}));
