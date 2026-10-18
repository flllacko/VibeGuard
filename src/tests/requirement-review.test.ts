import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { ConversationSchema, type Conversation } from "../intake.js";
import { intentUnits } from "../intent-units.js";
import { saveResolution } from "../resolution-storage.js";
import type { Resolution } from "../requirements.js";
import { registerTask } from "../task-registry.js";
import { applyRequirementReviewReply, confirmedRequirementSnapshot, createRequirementReview, readRequirementReview, requirementReviewView, RequirementReviewSelectionSchema, type StoredRequirementReview } from "../requirement-review.js";

function conversation(): Conversation {
  return ConversationSchema.parse({ schemaVersion: 1, taskId: "new-api", sessionId: "review-session", host: "codex-app-server",
    taskBoundary: { startMessageId: "u1", endMessageId: "a1" },
    transcriptCoverage: { level: "complete", source: "host_adapter", basis: "完整原始宿主采集", missingMessageIds: [] },
    hostCapture: { allReturnedPagesRead: true, scopeOnlyGap: false, unparsedUserContent: [] },
    messages: [{ id: "u1", role: "user", text: "增加登录功能。" }, { id: "u2", role: "user", text: "密码错误返回401。" }, { id: "u3", role: "user", text: "保留注册功能。" }, { id: "a1", role: "assistant", text: "已经完成。" }].map((item, index) => ({ ...item, sequence: index + 1 })) });
}
async function task(dataDir: string, source: Conversation) {
  const path = join(dataDir, `${randomUUID()}.source.json`); await writeFile(path, JSON.stringify(source) + "\n");
  return registerTask(dataDir, path, "checkpoint");
}
async function fixture(dataDir: string, source = conversation(), unresolved = false) {
  const registered = await task(dataDir, source);
  const users = source.messages.filter(item => item.role === "user");
  const resolution: Resolution = { schemaVersion: 1, resolutionId: randomUUID(), taskId: source.taskId, createdAt: new Date().toISOString(), conversationSha256: registered.conversationSha256,
    transcriptCoverage: source.transcriptCoverage, coverageIssues: unresolved ? ["存在尚未解释的用户消息", "存在尚未解释的用户原文片段"] : [],
    revisions: users.slice(0, unresolved ? 2 : 3).map((message, index) => ({ requirementId: `goal-${index + 1}`, revision: 1, status: "active", normalized: message.text, sourceKind: "explicit_user", sourceRefs: [{ messageId: message.id, start: 0, end: message.text.length, quote: message.text }] })),
    dispositions: users.map((message, index) => ({ messageId: message.id, kind: unresolved && index === 2 ? "unresolved" : "requirements", reason: "测试原话" })),
    interpretedUnits: intentUnits(source.messages).map((unit, index) => ({ ...unit, kind: unresolved && index === 2 ? "unresolved" : "requirement", reason: "测试原话", requirementIds: unresolved && index === 2 ? [] : [`goal-${index + 1}`] })),
    processing: [{ chunk: 1, messageIds: source.messages.map(item => item.id), status: "processed", model: "fixture" }], unprocessedUserMessageIds: [], resolutionComplete: !unresolved };
  await saveResolution(resolution, dataDir);
  return { source, registered, resolution, review: await createRequirementReview(dataDir, registered.taskRef, resolution.resolutionId) };
}
function reply(parent: Conversation, review: StoredRequirementReview, text: string, display = requirementReviewView(review).text): Conversation {
  const fresh = structuredClone(parent);
  const id = randomUUID();
  fresh.messages.push({ id: `display-${id}`, role: "assistant", text: display, sequence: fresh.messages.length + 1 });
  fresh.messages.push({ id: `reply-${id}`, role: "user", text, sequence: fresh.messages.length + 1 });
  fresh.taskBoundary.endMessageId = fresh.messages.at(-1)!.id;
  return fresh;
}
async function apply(dataDir: string, source: Conversation, review: StoredRequirementReview, text: string) {
  const fresh = reply(source, review, text), registered = await task(dataDir, fresh);
  return { source: fresh, registered, review: await applyRequirementReviewReply(dataDir, registered.taskRef, { reviewRef: review.reviewRef }) };
}
async function temporary(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-requirement-review-"));
  try { await action(directory); } finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
}

test("requirements review displays exact sources; confirmation persists as planning input, never a passed verdict", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir);
  const view = requirementReviewView(initial.review);
  assert.match(view.text, new RegExp(`VibeGuard 要求清单 ${initial.review.reviewRef.slice(0, 8)}`));
  assert.match(view.text, /增加登录功能/); assert.equal(view.planningEligible, false);
  assert.equal((await createRequirementReview(dataDir, initial.registered.taskRef, initial.resolution.resolutionId)).reviewRef, initial.review.reviewRef);
  const confirmed = await apply(dataDir, initial.source, initial.review, "理解正确，开始验收");
  assert.equal(confirmed.review.status, "confirmed");
  const loaded = await readRequirementReview(dataDir, confirmed.review.reviewRef);
  assert.deepEqual(loaded, confirmed.review);
  const snapshot = await confirmedRequirementSnapshot(dataDir, loaded.reviewRef);
  assert.equal(snapshot.requirements.length, 3); assert.equal("verdict" in snapshot, false);
  assert.match(snapshot.meaning, /不是验收通过/);
  assert.equal(JSON.parse(await readFile(join(dataDir, "resolutions", `${initial.resolution.resolutionId}.json`), "utf8")).resolutionComplete, true);
  assert.throws(() => RequirementReviewSelectionSchema.parse({ reviewRef: initial.review.reviewRef, confirmed: true }));
}));

test("replace cancel add merge preserve stable numbers and original sources; edits require a separate confirmation", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir);
  const edited = await apply(dataDir, initial.source, initial.review, "第2条改成密码错误返回403；取消第3条；新增：登录成功返回Token；其余确认");
  assert.equal(edited.review.status, "awaiting_review"); assert.equal(edited.review.confirmation, undefined);
  assert.equal(edited.review.items[1]!.normalized, "密码错误返回403");
  assert.equal(edited.review.items[2]!.status, "cancelled"); assert.equal(edited.review.items[3]!.displayId, "R4");
  assert.ok(edited.review.items[1]!.sourceRefs.some(item => item.quote === "密码错误返回401。"));
  assert.ok(edited.review.items[1]!.sourceRefs.some(item => item.quote.includes("改成密码错误返回403")));
  await assert.rejects(confirmedRequirementSnapshot(dataDir, edited.review.reviewRef), /not been completely confirmed/);
  const merged = await apply(dataDir, edited.source, edited.review, "合并R1和R4");
  assert.equal(merged.review.status, "awaiting_review"); assert.equal(merged.review.items[3]!.status, "cancelled");
  assert.match(merged.review.items[0]!.normalized, /增加登录功能。；登录成功返回Token/);
  assert.ok(merged.review.items[0]!.sourceRefs.length >= 3);
  const confirmed = await apply(dataDir, merged.source, merged.review, "确认");
  assert.deepEqual((await confirmedRequirementSnapshot(dataDir, confirmed.review.reviewRef)).requirements.map(item => item.displayId), ["R1", "R2"]);
}));

test("unknown statements and ambiguous confirmations stay as questions until explicitly classified", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir, conversation(), true);
  assert.equal(initial.review.status, "needs_clarification"); assert.equal(initial.review.unresolved[0]!.displayId, "Q1");
  const classified = await apply(dataDir, initial.source, initial.review, "Q1作为背景");
  assert.equal(classified.review.unresolved[0]!.resolved, true); assert.equal(classified.review.status, "awaiting_review");
  const unknown = await apply(dataDir, classified.source, classified.review, "确认，另外加验证码");
  assert.equal(unknown.review.status, "needs_clarification"); assert.equal(unknown.review.unresolved.at(-1)!.displayId, "Q2");
  const clarified = await apply(dataDir, unknown.source, unknown.review, "Q2作为要求：登录需要验证码");
  assert.equal(clarified.review.status, "awaiting_review"); assert.equal(clarified.review.items.at(-1)!.normalized, "登录需要验证码");
  const confirmed = await apply(dataDir, clarified.source, clarified.review, "确认");
  assert.equal(confirmed.review.status, "confirmed");
  assert.equal((await confirmedRequirementSnapshot(dataDir, confirmed.review.reviewRef)).requirements.length, 3);
  // Human classification is recorded separately; the original model result is not rewritten.
  assert.equal(JSON.parse(await readFile(join(dataDir, "resolutions", `${initial.resolution.resolutionId}.json`), "utf8")).resolutionComplete, false);
}));

test("image gaps survive requirement confirmation and cannot become executable planning input", async () => temporary(async dataDir => {
  const source = conversation(); source.transcriptCoverage.level = "partial"; source.hostCapture!.scopeOnlyGap = true;
  source.hostCapture!.unparsedUserContent = [{ messageId: "u1", count: 1 }];
  source.materialGaps = [{ kind: "unparsed_user_content", messageIds: ["u1"], count: 1, detail: "需求附图尚未解析" }];
  const initial = await fixture(dataDir, source);
  const confirmed = await apply(dataDir, source, initial.review, "确认");
  assert.equal(confirmed.review.status, "confirmed"); assert.ok(confirmed.review.materialIssues.length);
  assert.equal(requirementReviewView(confirmed.review).planningEligible, false);
  await assert.rejects(confirmedRequirementSnapshot(dataDir, confirmed.review.reviewRef), /material is incomplete/);
}));

test("replies reject cross-session forged prefix missing pages attachments and intervening user demands", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir);
  const bad: Conversation[] = [];
  const other = reply(initial.source, initial.review, "确认"); other.sessionId = "other"; bad.push(other);
  const changed = reply(initial.source, initial.review, "确认"); changed.messages[0]!.text = "改写的历史"; bad.push(changed);
  const unread = reply(initial.source, initial.review, "确认"); unread.hostCapture!.allReturnedPagesRead = false; bad.push(unread);
  const ledger = reply(initial.source, initial.review, "确认"); delete ledger.hostCapture; bad.push(ledger);
  const attachment = reply(initial.source, initial.review, "确认"); attachment.hostCapture!.unparsedUserContent.push({ messageId: attachment.messages.at(-1)!.id, count: 1 }); bad.push(attachment);
  const missing = reply(initial.source, initial.review, "确认"); missing.transcriptCoverage.missingMessageIds.push("possible-demand"); bad.push(missing);
  const extra = reply(initial.source, initial.review, "确认"); extra.messages.splice(-1, 0, { id: "another-user", role: "user", text: "再做支付", sequence: extra.messages.length }); extra.messages.forEach((item, index) => item.sequence = index + 1); bad.push(extra);
  const summary = reply(initial.source, initial.review, "确认"); summary.transcriptCoverage.source = "agent_summary"; bad.push(summary);
  for (const source of bad) await assert.rejects(applyRequirementReviewReply(dataDir, (await task(dataDir, source)).taskRef, { reviewRef: initial.review.reviewRef }));
  const actual = await apply(dataDir, initial.source, initial.review, "确认"); assert.equal(actual.review.status, "confirmed");
}));

test("confirmation is bound to the full latest canonical list; tool-selected old references and quoted approvals cannot pass", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir);
  for (const display of ["请确认这些要求", `VibeGuard 要求清单 ${initial.review.reviewRef.slice(0, 8)}\n摘要而非完整清单`, `${requirementReviewView(initial.review).text}\nVibeGuard 要求清单 abcdef12`, `${requirementReviewView(initial.review).text}\n以上作废，最终R1改为增加支付功能，请确认。`]) {
    const current = await task(dataDir, reply(initial.source, initial.review, "确认", display));
    await assert.rejects(applyRequirementReviewReply(dataDir, current.taskRef, { reviewRef: initial.review.reviewRef }), /canonical review/);
  }
  const changedAfterDisplay = reply(initial.source, initial.review, "确认");
  changedAfterDisplay.messages.splice(-1, 0, { id: "assistant-revision", role: "assistant", text: "以上作废，最终R1改为增加支付功能，请确认。", sequence: changedAfterDisplay.messages.length });
  changedAfterDisplay.messages.forEach((item, index) => item.sequence = index + 1);
  await assert.rejects(applyRequirementReviewReply(dataDir, (await task(dataDir, changedAfterDisplay)).taskRef, { reviewRef: initial.review.reviewRef }), /canonical review/);
  const quoted = await apply(dataDir, initial.source, initial.review, "文档说“确认”");
  assert.equal(quoted.review.status, "needs_clarification");
}));

test("host question wrappers use only actual answers and can carry the canonical list", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir);
  const wrapped = `<send_user_message_question_reply>\n${JSON.stringify([{ question: requirementReviewView(initial.review).text, answer: "确认" }])}\n</send_user_message_question_reply>`;
  const fresh = await task(dataDir, reply(initial.source, initial.review, wrapped, "请回答下面的问题"));
  const result = await applyRequirementReviewReply(dataDir, fresh.taskRef, { reviewRef: initial.review.reviewRef });
  assert.equal(result.status, "confirmed"); assert.equal(result.confirmation!.quote, wrapped);
}));

test("one review consumes one reply idempotently; old replies and disk or source edits fail on restart", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir);
  const edited = await apply(dataDir, initial.source, initial.review, "第1条改成增加账号密码登录");
  assert.equal((await applyRequirementReviewReply(dataDir, edited.registered.taskRef, { reviewRef: initial.review.reviewRef })).reviewRef, edited.review.reviewRef);
  const competing = await task(dataDir, reply(initial.source, initial.review, "取消第1条"));
  await assert.rejects(applyRequirementReviewReply(dataDir, competing.taskRef, { reviewRef: initial.review.reviewRef }), /already consumed/);
  await assert.rejects(applyRequirementReviewReply(dataDir, edited.registered.taskRef, { reviewRef: edited.review.reviewRef }), /stale/);
  const file = join(dataDir, "requirement-reviews", `${edited.review.reviewRef}.json`);
  const saved = await readFile(file, "utf8"), parsed = JSON.parse(saved); parsed.items[0].normalized = "伪造目标";
  await writeFile(file, JSON.stringify(parsed)); await assert.rejects(readRequirementReview(dataDir, edited.review.reviewRef), /content hash/);
  await writeFile(file, saved);
  const resolutionFile = join(dataDir, "resolutions", `${initial.resolution.resolutionId}.json`), resolution = JSON.parse(await readFile(resolutionFile, "utf8"));
  resolution.revisions[0].sourceRefs[0].quote = "伪造原话"; await writeFile(resolutionFile, JSON.stringify(resolution));
  await assert.rejects(readRequirementReview(dataDir, edited.review.reviewRef), /original user text/);
}));

test("original user exports can be reviewed; aliases work and cancelling every goal cannot produce planning input", async () => temporary(async dataDir => {
  const source = conversation(); source.transcriptCoverage.source = "user_export";
  const initial = await fixture(dataDir, source);
  assert.equal(initial.review.status, "awaiting_review");
  const hostSource = structuredClone(source); hostSource.transcriptCoverage.source = "host_adapter";
  const changed = await apply(dataDir, hostSource, initial.review, "第2条改为错误密码返回403；第3条取消；补充：支持退出登录；其他确认");
  assert.equal(changed.review.status, "awaiting_review"); assert.equal(changed.review.items[1]!.normalized, "错误密码返回403");
  assert.equal(changed.review.items[2]!.status, "cancelled"); assert.equal(changed.review.items[3]!.displayId, "R4");
  const cancelled = await apply(dataDir, changed.source, changed.review, "删除第1条；取消第2条；第4条本次不验");
  const confirmed = await apply(dataDir, cancelled.source, cancelled.review, "确认");
  assert.equal(confirmed.review.status, "confirmed"); assert.equal(requirementReviewView(confirmed.review).planningEligible, false);
  await assert.rejects(confirmedRequirementSnapshot(dataDir, confirmed.review.reviewRef), /No active requirements/);
}));

test("failed model chunks remain material issues despite explicit requirement confirmation", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir);
  const file = join(dataDir, "resolutions", `${initial.resolution.resolutionId}.json`);
  const resolution = JSON.parse(await readFile(file, "utf8"));
  resolution.resolutionId = randomUUID(); resolution.processing[0].status = "failed"; resolution.resolutionComplete = false;
  await saveResolution(resolution as Resolution, dataDir);
  const review = await createRequirementReview(dataDir, initial.registered.taskRef, resolution.resolutionId);
  const confirmed = await apply(dataDir, initial.source, review, "确认");
  assert.equal(confirmed.review.status, "confirmed"); assert.ok(confirmed.review.materialIssues.some(item => item.includes("失败分块")));
  await assert.rejects(confirmedRequirementSnapshot(dataDir, confirmed.review.reviewRef), /material is incomplete/);
}));

test("confirmed requirements can be amended; superseded snapshots fail and a new confirmation is required", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir), confirmed = await apply(dataDir, initial.source, initial.review, "确认");
  const historical = await confirmedRequirementSnapshot(dataDir, confirmed.review.reviewRef);
  assert.equal(historical.currentness, "historical_version"); assert.equal(historical.requiresFreshCaptureBeforePlanning, true);
  const canonicalBefore = requirementReviewView(confirmed.review).text;
  const changed = await apply(dataDir, confirmed.source, confirmed.review, "第2条改成错误密码返回403");
  assert.equal(changed.review.status, "awaiting_review"); assert.equal(changed.review.confirmation, undefined);
  assert.equal(requirementReviewView(await readRequirementReview(dataDir, confirmed.review.reviewRef)).text, canonicalBefore);
  await assert.rejects(confirmedRequirementSnapshot(dataDir, confirmed.review.reviewRef), /superseded/);
  await assert.rejects(confirmedRequirementSnapshot(dataDir, changed.review.reviewRef), /not been completely confirmed/);
  const reconfirmed = await apply(dataDir, changed.source, changed.review, "确认");
  assert.equal((await confirmedRequirementSnapshot(dataDir, reconfirmed.review.reviewRef)).requirements[1]!.normalized, "错误密码返回403");
}));

test("currentness is checked only against an independently captured unchanged user history", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir), confirmed = await apply(dataDir, initial.source, initial.review, "确认");
  const view = requirementReviewView(confirmed.review);
  assert.equal(view.currentness, "not_checked_against_latest_chat"); assert.match(view.planningEligibilityMeaning, /不是|不代表/);
  const sameCapture = await confirmedRequirementSnapshot(dataDir, confirmed.review.reviewRef, confirmed.registered.taskRef);
  assert.equal(sameCapture.currentness, "checked_at_capture"); assert.equal(sameCapture.requiresFreshCaptureBeforePlanning, false);
  assert.equal(sameCapture.checkedConversationSha256, confirmed.registered.conversationSha256);
  const later = structuredClone(confirmed.source);
  later.messages.push({ id: "later-assistant", role: "assistant", sequence: later.messages.length + 1, text: "已记录当前要求。" }); later.taskBoundary.endMessageId = "later-assistant";
  const laterTask = await task(dataDir, later);
  assert.equal((await confirmedRequirementSnapshot(dataDir, confirmed.review.reviewRef, laterTask.taskRef)).currentness, "checked_at_capture");
  const invalid: Conversation[] = [];
  const newUser = structuredClone(later); newUser.messages.push({ id: "new-goal", role: "user", sequence: newUser.messages.length + 1, text: "增加支付功能。" }); newUser.taskBoundary.endMessageId = "new-goal"; invalid.push(newUser);
  const other = structuredClone(later); other.sessionId = "another-session"; invalid.push(other);
  const prefix = structuredClone(later); prefix.messages[0]!.text = "历史被改写"; invalid.push(prefix);
  const image = structuredClone(later); image.hostCapture!.unparsedUserContent.push({ messageId: "u1", count: 1 }); invalid.push(image);
  const summary = structuredClone(later); summary.transcriptCoverage.source = "agent_summary"; invalid.push(summary);
  const pages = structuredClone(later); pages.hostCapture!.allReturnedPagesRead = false; invalid.push(pages);
  for (const current of invalid) await assert.rejects(confirmedRequirementSnapshot(dataDir, confirmed.review.reviewRef, (await task(dataDir, current)).taskRef));
}));

test("renderer groups references from each original message while preserving every structured source", async () => temporary(async dataDir => {
  const initial = await fixture(dataDir);
  const resolution = structuredClone(initial.resolution); resolution.resolutionId = randomUUID();
  resolution.revisions[0]!.sourceRefs.push({ messageId: "u1", start: 0, end: 2, quote: "增加" });
  resolution.revisions[0]!.sourceRefs.push({ messageId: "u2", start: 0, end: 4, quote: "密码错误" });
  await saveResolution(resolution, dataDir);
  const review = await createRequirementReview(dataDir, initial.registered.taskRef, resolution.resolutionId), view = requirementReviewView(review);
  assert.equal(view.items[0]!.sourceRefs.length, 3);
  const firstItemText = view.text.split("R2 当前要求")[0]!;
  assert.match(firstItemText, /同消息另有 1 处引用，完整引用已保存/);
  assert.match(firstItemText, /> 增加登录功能。/); assert.match(firstItemText, /> 密码错误/);
  assert.doesNotMatch(firstItemText, /> 增加\n/);
}));
