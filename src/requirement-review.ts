import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SourceRef } from "./contracts.js";
import { readConversation, type Conversation, type ConversationMessage, type IntakeResult } from "./intake.js";
import { intentUnits, validateUnitCoverage } from "./intent-units.js";
import { readResolution } from "./resolution-storage.js";
import type { Resolution } from "./requirements.js";
import { readTask, RefSchema } from "./task-registry.js";
import { readSelectedScopeParent, readTaskIntake } from "./task-scope.js";
import { sha256 } from "./storage.js";
import {
  applyReviewReplyProposal, reviewReplyInput, reviewReplyInputHash, ReviewReplyInterpretationSchema, ReviewReplyProposalSchema,
  type ReviewReplyGateway, type ReviewReplyInterpretation,
} from "./review-reply-intent.js";

export const REQUIREMENT_REVIEW_POLICY_VERSION = "original-user-review-v2-model-intent";
export const RequirementReviewSelectionSchema = z.object({ reviewRef: RefSchema }).strict();
export type RequirementReviewSelection = z.infer<typeof RequirementReviewSelectionSchema>;
const SourceSchema = z.object({ messageId: z.string().min(1), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), quote: z.string().min(1) }).strict();
const ItemSchema = z.object({ displayId: z.string().regex(/^R[1-9]\d*$/), requirementId: z.string().min(1), normalized: z.string().min(1), status: z.enum(["active", "cancelled"]), sourceRefs: z.array(SourceSchema).min(1) }).strict();
const QuestionSchema = z.object({ displayId: z.string().regex(/^Q[1-9]\d*$/), sourceRefs: z.array(SourceSchema).min(1), quote: z.string().min(1), reason: z.string().min(1), resolved: z.boolean(), disposition: z.enum(["unresolved", "context", "requirement"]) }).strict();
const ChangeSchema = z.object({ kind: z.enum(["replace", "cancel", "restore", "add", "merge", "clarify", "unknown"]), targets: z.array(z.string()), detail: z.string(), source: SourceSchema }).strict();
const ConfirmationSchema = z.object({ freshTaskRef: RefSchema, conversationSha256: z.string().regex(/^[a-f0-9]{64}$/), messageId: z.string().min(1), quote: z.string().min(1), meaning: z.literal("确认要求理解，不是验收通过") }).strict();
const ReviewSchema = z.object({
  schemaVersion: z.literal(1), policyVersion: z.enum(["original-user-review-v1", REQUIREMENT_REVIEW_POLICY_VERSION]), reviewRef: RefSchema,
  taskRef: RefSchema, resolutionId: RefSchema, baseConversationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  anchorConversationSha256: z.string().regex(/^[a-f0-9]{64}$/), taskRecordHash: z.string(), resolutionHash: z.string(),
  sessionId: z.string().min(1), host: z.string().min(1), createdAt: z.string().datetime(),
  lineageDepth: z.number().int().min(0).max(31),
  status: z.enum(["awaiting_review", "needs_clarification", "confirmed"]), parentReviewRef: RefSchema.optional(),
  items: z.array(ItemSchema), unresolved: z.array(QuestionSchema), materialIssues: z.array(z.string().min(1)), changes: z.array(ChangeSchema),
  reply: ConfirmationSchema.optional(), confirmation: ConfirmationSchema.optional(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  interpretation: ReviewReplyInterpretationSchema.optional(),
}).strict();
export type StoredRequirementReview = z.infer<typeof ReviewSchema>;
type ReviewBody = Omit<StoredRequirementReview, "contentHash">;
type Item = StoredRequirementReview["items"][number];
type Question = StoredRequirementReview["unresolved"][number];
type Change = StoredRequirementReview["changes"][number];
const ReceiptSchema = z.object({ freshTaskRef: RefSchema, freshConversationSha256: z.string(), childReviewRef: RefSchema }).strict();
const MAX_DEPTH = 32;

function hash(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stable(entry)])) : item;
  return sha256(JSON.stringify(stable(value)));
}
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
function directory(dataDir: string) { return join(dataDir, "requirement-reviews"); }
function receiptPath(dataDir: string, reviewRef: string) { return join(directory(dataDir), `${reviewRef}.reply.json`); }
function seal(body: ReviewBody): StoredRequirementReview { return ReviewSchema.parse({ ...body, contentHash: hash(body) }); }
function source(message: ConversationMessage): SourceRef { return { messageId: message.id, start: 0, end: message.text.length, quote: message.text }; }
function validateSources(refs: SourceRef[], messages: ConversationMessage[]) {
  for (const ref of refs) {
    const message = messages.find(item => item.id === ref.messageId);
    if (!message || message.role !== "user" || ref.end <= ref.start || message.text.slice(ref.start, ref.end) !== ref.quote || ref.end > message.text.length) throw new Error("Review source must quote saved original user text exactly");
  }
}
function appendRefs(...sets: SourceRef[][]): SourceRef[] {
  const refs = sets.flat();
  return refs.filter((item, index) => refs.findIndex(other => hash(other) === hash(item)) === index);
}

async function baseMaterial(dataDir: string, taskRef: string, resolutionId: string) {
  const task = await readTask(dataDir, taskRef);
  if (task.execution.kind !== "requirements_only") throw new Error("Requirement review requires a task without a previously bound execution plan");
  const intake = await readTaskIntake(dataDir, task);
  const resolution = await readResolution(resolutionId, dataDir);
  if (resolution.resolutionId !== resolutionId || resolution.taskId !== task.taskId || resolution.conversationSha256 !== intake.rawSha256) throw new Error("Requirement resolution does not match the original task");
  if (intake.conversation.transcriptCoverage.source === "agent_summary") throw new Error("Requirement review requires original material, not an Agent summary");
  if (intake.conversation.selectedScope) await readSelectedScopeParent(dataDir, intake.conversation);
  for (const revision of resolution.revisions) validateSources(revision.sourceRefs, intake.conversation.messages);
  for (const unit of resolution.interpretedUnits ?? []) validateSources([unit], intake.conversation.messages);
  const issues = new Set(intake.coverageIssues);
  for (const issue of resolution.coverageIssues) if (!/^存在尚未解释的用户(?:消息|原文片段)$/.test(issue)) issues.add(issue);
  if (resolution.unprocessedUserMessageIds.length || resolution.processing.some(item => item.status !== "processed")) issues.add("原始要求整理存在未处理消息或失败分块，确认理解不能补齐。");
  const processedMessages = new Set(resolution.processing.filter(item => item.status === "processed").flatMap(item => item.messageIds));
  if (intake.userMessageIds.some(id => !processedMessages.has(id))) issues.add("部分原始用户消息缺少成功处理的分块记录，确认理解不能补齐。");
  if (!resolution.interpretedUnits) issues.add("旧要求记录缺少逐段文字处理账目，尚不能生成规划快照。");
  else {
    try { validateUnitCoverage(intentUnits(intake.conversation.messages), resolution.interpretedUnits); }
    catch { issues.add("要求整理的原文分段账目不完整，确认理解不能补齐。"); }
  }
  const ledger = intake.conversation.hostCapture;
  if (intake.conversation.host === "codex-app-server" && !intake.conversation.selectedScope && (!ledger || !ledger.allReturnedPagesRead)) issues.add("原始 Codex 材料缺少完整分页账目。");
  if (ledger?.unparsedUserContent.length) issues.add("原始材料包含未解析用户附件，确认理解不能清除。");
  const anchorSha = intake.conversation.selectedScope?.confirmation.conversationSha256 ?? intake.rawSha256;
  const anchor = await readConversation(join(dataDir, "conversations", `${anchorSha}.json`));
  if (anchor.rawSha256 !== anchorSha || anchor.conversation.sessionId !== intake.conversation.sessionId || anchor.conversation.host !== intake.conversation.host) throw new Error("Review anchor source changed");
  return { task, intake, resolution, anchorSha, issues: [...issues] };
}

function initialItems(resolution: Resolution): Item[] {
  const latest = new Map<string, Resolution["revisions"][number]>();
  for (const revision of resolution.revisions) latest.set(revision.requirementId, revision);
  return [...latest.values()].map((revision, index) => ({ displayId: `R${index + 1}`, requirementId: revision.requirementId,
    normalized: revision.normalized, status: revision.status === "cancelled" ? "cancelled" : "active", sourceRefs: structuredClone(revision.sourceRefs) }));
}
function initialQuestions(resolution: Resolution, conversation: Conversation): Question[] {
  const units = (resolution.interpretedUnits ?? []).filter(unit => unit.kind === "unresolved");
  const questions: Omit<Question, "displayId">[] = units.map(unit => ({ sourceRefs: [{ messageId: unit.messageId, start: unit.start, end: unit.end, quote: unit.quote }], quote: unit.quote, reason: unit.reason, resolved: false, disposition: "unresolved" }));
  for (const disposition of resolution.dispositions.filter(item => item.kind === "unresolved")) {
    if (!units.some(unit => unit.messageId === disposition.messageId)) {
      const message = conversation.messages.find(item => item.id === disposition.messageId);
      if (!message || message.role !== "user") throw new Error("Unresolved source missing from original user material");
      questions.push({ sourceRefs: [source(message)], quote: message.text, reason: disposition.reason, resolved: false, disposition: "unresolved" });
    }
  }
  return questions.map((item, index) => ({ ...item, displayId: `Q${index + 1}` }));
}

export async function createRequirementReview(dataDir: string, taskRef: string, resolutionId: string): Promise<StoredRequirementReview> {
  RefSchema.parse(taskRef); RefSchema.parse(resolutionId);
  const base = await baseMaterial(dataDir, taskRef, resolutionId);
  const cache = join(directory(dataDir), `${hash({ taskRef, resolutionId, policy: REQUIREMENT_REVIEW_POLICY_VERSION })}.cache.json`);
  try {
    const existing = z.object({ reviewRef: RefSchema }).strict().parse(JSON.parse(await readFile(cache, "utf8")));
    return await readRequirementReview(dataDir, existing.reviewRef);
  } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  const unresolved = initialQuestions(base.resolution, base.intake.conversation);
  const review = seal({ schemaVersion: 1, policyVersion: REQUIREMENT_REVIEW_POLICY_VERSION, reviewRef: randomUUID(), taskRef, resolutionId,
    baseConversationSha256: base.intake.rawSha256, anchorConversationSha256: base.anchorSha, taskRecordHash: hash(base.task), resolutionHash: hash(base.resolution),
    sessionId: base.intake.conversation.sessionId, host: base.intake.conversation.host, createdAt: new Date().toISOString(),
    lineageDepth: 0,
    status: unresolved.length ? "needs_clarification" : "awaiting_review", items: initialItems(base.resolution), unresolved, materialIssues: base.issues, changes: [] });
  await saveReview(dataDir, review);
  try { await writeFile(cache, JSON.stringify({ reviewRef: review.reviewRef }) + "\n", { flag: "wx" }); }
  catch (error) { if (!hasCode(error, "EEXIST")) throw error; const existing = JSON.parse(await readFile(cache, "utf8")) as { reviewRef: string }; return readRequirementReview(dataDir, existing.reviewRef); }
  return review;
}

async function saveReview(dataDir: string, review: StoredRequirementReview) {
  await mkdir(directory(dataDir), { recursive: true });
  await writeFile(join(directory(dataDir), `${review.reviewRef}.json`), JSON.stringify(review, null, 2) + "\n", { flag: "wx" });
}

export function requirementReviewView(review: StoredRequirementReview) {
  const lines = [`VibeGuard 要求清单 ${review.reviewRef.slice(0, 8)}`, "", "请核对当前要求。确认只代表理解正确，不代表任务完成或验收通过。", ""];
  for (const item of review.items) {
    lines.push(`${item.displayId} ${item.status === "active" ? "当前要求" : "本次不验"}：${item.normalized}`, "用户原话与修订依据：");
    const sources = new Map<string, SourceRef[]>();
    for (const ref of item.sourceRefs) sources.set(ref.messageId, [...(sources.get(ref.messageId) ?? []), ref]);
    for (const refs of sources.values()) {
      lines.push(...refs[0]!.quote.split("\n").map(line => `> ${line}`));
      if (refs.length > 1) lines.push(`同消息另有 ${refs.length - 1} 处引用，完整引用已保存。`);
    }
    lines.push("");
  }
  if (!review.items.length) lines.push("尚未整理出有效要求。", "");
  for (const question of review.unresolved) lines.push(`${question.displayId} ${question.resolved ? `已处理（${question.disposition === "context" ? "背景／本次不验" : "已转为要求"}）` : "需要澄清"}：${question.reason}`, ...question.quote.split("\n").map(line => `> ${line}`), "");
  if (review.materialIssues.length) lines.push("材料缺口（确认理解不能清除）：", ...review.materialIssues.map(item => `- ${item}`), "");
  if (review.changes.length) lines.push("本轮变化：", ...review.changes.map(change => `- ${change.detail}`), "");
  lines.push(review.status === "confirmed" ? "要求理解已确认；尚无实际执行证据。" : review.policyVersion === "original-user-review-v1"
    ? "可直接回复：确认；第2条改成……；取消第3条；新增：……；合并R1和R2；Q1作为背景；Q1作为要求：……。"
    : "可以用自己的说法纠正、补充、排除或合并要求，无需填写编号或固定命令。意思不清楚时会提出具体问题；理解正确可回复“确认”。", "修改后会展示新清单，再次确认后才可继续；不明确的文字会保留为待澄清项。");
  if (review.interpretation?.mode === "unavailable") lines.push("本轮修订模型不可用或候选未通过核对，尚未应用任何修改；原始回复已保留。");
  return { reviewRef: review.reviewRef, status: review.status, items: review.items, unresolved: review.unresolved, materialIssues: review.materialIssues, changes: review.changes,
    meaning: "要求审查，不是完成证明", currentness: "not_checked_against_latest_chat" as const,
    planningEligibilityMeaning: "仅表示已保存版本具备结构条件；尚未核对最新聊天，不代表当前版本许可或业务执行授权。",
    planningEligible: review.status === "confirmed" && review.items.some(item => item.status === "active") && !review.materialIssues.length && !review.unresolved.some(item => !item.resolved), text: lines.join("\n") };
}

function actualAnswer(text: string): { answer: string; question?: string } {
  const wrapped = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(text.trim());
  if (!wrapped) return { answer: text.trim() };
  try {
    const replies = z.array(z.object({ answer: z.string(), question: z.string().optional() }).passthrough()).length(1).parse(JSON.parse(wrapped[1]!));
    return { answer: replies[0]!.answer.trim(), question: replies[0]!.question };
  } catch { return { answer: "" }; }
}

function validateReply(review: StoredRequirementReview, anchor: IntakeResult, fresh: IntakeResult) {
  const current = fresh.conversation;
  if (current.sessionId !== review.sessionId || current.host !== review.host || current.transcriptCoverage.source !== "host_adapter") throw new Error("Review reply must come from the same independently captured host session");
  if (current.selectedScope || fresh.structuralIssues.length || current.transcriptCoverage.missingMessageIds.length) throw new Error("Review reply capture contains structural gaps or missing messages");
  const ledger = current.hostCapture;
  if (review.host === "codex-app-server" && (!ledger || !ledger.allReturnedPagesRead)) throw new Error("Review reply requires complete Codex pagination and attachment ledger");
  if (current.transcriptCoverage.level !== "complete" && !(current.transcriptCoverage.level === "partial" && ledger?.scopeOnlyGap && ledger.allReturnedPagesRead)) throw new Error("Review reply history coverage is unknown");
  const original = anchor.conversation.messages;
  if (current.messages.length <= original.length || original.some((item, index) => { const next = current.messages[index]; return !next || item.id !== next.id || item.sequence !== next.sequence || item.role !== next.role || item.text !== next.text; })) throw new Error("Review reply is stale or the original prefix changed");
  const added = current.messages.slice(original.length), users = added.filter(item => item.role === "user");
  const reply = users[0];
  if (users.length !== 1 || !reply || current.messages.at(-1)?.id !== reply.id) throw new Error("Need exactly one new original user reply ending this capture; intervening new requirements need a fresh review");
  const oldGaps = anchor.conversation.materialGaps ?? [];
  if (current.materialGaps?.some(gap => gap.kind !== "unparsed_user_content" || !oldGaps.some(old => hash(old) === hash(gap)))) throw new Error("Review reply contains unknown material gaps");
  if (ledger?.unparsedUserContent.some(item => added.some(message => message.id === item.messageId)) || current.materialGaps?.some(gap => gap.messageIds.includes(reply.id))) throw new Error("Review reply includes unparsed user content");
  const oldNontext = anchor.conversation.hostCapture?.unparsedUserContent ?? [];
  if (oldNontext.some(item => !ledger?.unparsedUserContent.some(next => hash(next) === hash(item))) || ledger?.unparsedUserContent.some(item => !oldNontext.some(old => hash(old) === hash(item)))) throw new Error("Review reply attachment ledger changed outside the original prefix");
  const answer = actualAnswer(reply.text);
  const canonical = requirementReviewView(review).text;
  const displays = added.filter(item => item.role === "assistant").map(item => item.text);
  if (answer.question) displays.push(answer.question);
  // A full list followed by a rewritten "final" requirement is not the same
  // display. Require the final assistant message/question to be the list alone.
  if (displays.at(-1)?.trim() !== canonical.trim()) throw new Error("The latest displayed canonical review does not match this reply");
  return { reply, answer: answer.answer };
}

function parseReply(review: StoredRequirementReview, reply: ConversationMessage, answer: string) {
  const items = structuredClone(review.items), unresolved = structuredClone(review.unresolved), changes: Change[] = [];
  const ref = source(reply);
  const itemFor = (id: string) => items.find(item => item.displayId === id.toUpperCase());
  const nextId = (prefix: string, values: { displayId: string }[]) => `${prefix}${Math.max(0, ...values.map(item => Number(item.displayId.slice(1)))) + 1}`;
  const add = (normalized: string, refs: SourceRef[]) => { const displayId = nextId("R", items); const item: Item = { displayId, requirementId: `review-${review.reviewRef.slice(0, 8)}-${displayId.toLowerCase()}`, normalized, status: "active", sourceRefs: refs }; items.push(item); return item; };
  const unknown = (text: string, reason: string) => { const displayId = nextId("Q", unresolved); unresolved.push({ displayId, sourceRefs: [ref], quote: text || reply.text, reason, resolved: false, disposition: "unresolved" }); changes.push({ kind: "unknown", targets: [displayId], detail: `${displayId} 需要澄清：${reason}`, source: ref }); };
  // This deliberately bounded grammar is not general natural-language understanding.
  const clauses = answer.split(/[；;\n]+|[，,](?=(?:第?\d+条|取消|删除|(?:新增|补充)[：:]|合并\s*[Rr]|[Qq]\d+|(?:其余|其他)确认))/u).map(item => item.trim().replace(/[。！!]+$/, "")).filter(Boolean);
  let confirm = false;
  for (const clause of clauses) {
    if (/^(?:确认|确认要求|理解正确|理解正确[，,]?开始验收|以上理解正确[，,]?开始验收)$/.test(clause)) { confirm = true; continue; }
    if (/^(?:其余|其他)确认$/.test(clause) && changes.length) continue;
    let match = /^(?:第(\d+)条|([Rr]\d+))\s*(?:改成|改为)\s*[：:]?\s*(.+)$/u.exec(clause);
    if (match) {
      const item = itemFor(match[2] ?? `R${match[1]}`);
      if (!item || item.status !== "active") { unknown(clause, "修改对象不是当前有效要求"); continue; }
      item.normalized = match[3]!.trim(); item.sourceRefs = appendRefs(item.sourceRefs, [ref]);
      changes.push({ kind: "replace", targets: [item.displayId], detail: `${item.displayId} 修改为：${item.normalized}`, source: ref }); continue;
    }
    match = /^(?:(?:取消|删除)\s*(?:第(\d+)条|([Rr]\d+))|(?:第(\d+)条|([Rr]\d+))\s*(?:本次不验|取消))$/u.exec(clause);
    if (match) {
      const item = itemFor(match[2] ?? match[4] ?? `R${match[1] ?? match[3]}`);
      if (!item || item.status !== "active") { unknown(clause, "取消对象不是当前有效要求"); continue; }
      item.status = "cancelled"; item.sourceRefs = appendRefs(item.sourceRefs, [ref]);
      changes.push({ kind: "cancel", targets: [item.displayId], detail: `${item.displayId} 本次不验`, source: ref }); continue;
    }
    match = /^(?:新增|补充)\s*[：:]\s*(.+)$/u.exec(clause);
    if (match) { const item = add(match[1]!.trim(), [ref]); changes.push({ kind: "add", targets: [item.displayId], detail: `${item.displayId} 新增：${item.normalized}`, source: ref }); continue; }
    match = /^合并\s*([Rr]\d+)\s*(?:和|与|、)\s*([Rr]\d+)(?:\s*(?:[：:]|改成|为)\s*(.+))?$/u.exec(clause);
    if (match) {
      const first = itemFor(match[1]!), second = itemFor(match[2]!);
      if (!first || !second || first === second || first.status !== "active" || second.status !== "active") { unknown(clause, "合并需要两个不同的当前有效要求"); continue; }
      first.normalized = match[3]?.trim() || `${first.normalized}；${second.normalized}`; first.sourceRefs = appendRefs(first.sourceRefs, second.sourceRefs, [ref]); second.status = "cancelled"; second.sourceRefs = appendRefs(second.sourceRefs, [ref]);
      changes.push({ kind: "merge", targets: [first.displayId, second.displayId], detail: `${second.displayId} 合并到 ${first.displayId}：${first.normalized}`, source: ref }); continue;
    }
    match = /^([Qq]\d+)\s*(?:作为背景|本次不验|作为要求\s*[：:]\s*(.+))$/u.exec(clause);
    if (match) {
      const question = unresolved.find(item => item.displayId === match![1]!.toUpperCase());
      if (!question || question.resolved) { unknown(clause, "澄清对象不存在或已处理"); continue; }
      question.resolved = true; question.disposition = match[2] ? "requirement" : "context"; question.sourceRefs = appendRefs(question.sourceRefs, [ref]);
      const targets = [question.displayId];
      if (match[2]) targets.push(add(match[2].trim(), question.sourceRefs).displayId);
      changes.push({ kind: "clarify", targets, detail: `${question.displayId} ${match[2] ? "已转为要求" : "作为背景／本次不验"}`, source: ref }); continue;
    }
    unknown(clause, "当前有限指令解析器无法确定这段回复的含义，请使用清单中的明确表达");
  }
  if (!clauses.length) unknown(reply.text, "没有读取到明确的原始用户回复");
  const pending = unresolved.some(item => !item.resolved);
  const status: StoredRequirementReview["status"] = pending ? "needs_clarification" : changes.length ? "awaiting_review" : confirm ? "confirmed" : "needs_clarification";
  return { items, unresolved, changes, status };
}

function replayReply(review: StoredRequirementReview, reply: ConversationMessage, answer: string, interpretation?: ReviewReplyInterpretation) {
  if (!interpretation) return parseReply(review, reply, answer);
  if (interpretation.mode === "model") {
    if (interpretation.inputHash !== reviewReplyInputHash(reviewReplyInput(review, answer))) throw new Error("修订模型输入与当前清单或原始回复不一致。");
    return applyReviewReplyProposal(review, reply, answer, interpretation.proposal);
  }
  const displayId = `Q${Math.max(0, ...review.unresolved.map(item => Number(item.displayId.slice(1)))) + 1}`, ref = source(reply);
  return { items: structuredClone(review.items), unresolved: [...structuredClone(review.unresolved), { displayId, sourceRefs: [ref], quote: answer || reply.text,
    reason: interpretation.reason, resolved: false, disposition: "unresolved" as const }],
    changes: [{ kind: "unknown" as const, targets: [displayId], detail: `${displayId}：${interpretation.reason}`, source: ref }], status: "needs_clarification" as const };
}

export async function applyRequirementReviewReply(dataDir: string, freshTaskRef: string, selection: RequirementReviewSelection, gateway?: ReviewReplyGateway): Promise<StoredRequirementReview> {
  RequirementReviewSelectionSchema.parse(selection); RefSchema.parse(freshTaskRef);
  const review = await readRequirementReview(dataDir, selection.reviewRef);
  const freshTask = await readTask(dataDir, freshTaskRef);
  if (freshTask.execution.kind !== "requirements_only") throw new Error("Review replies cannot reuse an existing execution plan");
  const fresh = await readTaskIntake(dataDir, freshTask);
  try {
    const receipt = ReceiptSchema.parse(JSON.parse(await readFile(receiptPath(dataDir, review.reviewRef), "utf8")));
    if (receipt.freshConversationSha256 !== fresh.rawSha256) throw new Error("This review has already consumed another reply; use the latest displayed review");
    return readRequirementReview(dataDir, receipt.childReviewRef);
  } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  if (review.lineageDepth >= MAX_DEPTH - 1) throw new Error("Requirement review reached its bounded revision depth; consolidate a new review before further replies");
  const anchor = await readConversation(join(dataDir, "conversations", `${review.anchorConversationSha256}.json`));
  if (anchor.rawSha256 !== review.anchorConversationSha256) throw new Error("Review anchor hash mismatch");
  const { reply, answer } = validateReply(review, anchor, fresh);
  let interpretation: ReviewReplyInterpretation | undefined;
  // Whole-message, explicit confirmations need no extra model call. All other
  // production replies use semantic interpretation, independent of business rules.
  if (gateway && !/^(?:确认|确认要求|理解正确|理解正确[，,]?开始验收|以上理解正确[，,]?开始验收)[。！!]*$/.test(answer.trim())) {
    const input = reviewReplyInput(review, answer), attempts: { status: "accepted" | "rejected"; reason?: string }[] = [];
    let validationFeedback: string | undefined;
    let usage: { inputTokens: number; outputTokens: number; estimatedCostUsd?: number } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let output: Awaited<ReturnType<ReviewReplyGateway["propose"]>>;
      try { output = await gateway.propose(input, validationFeedback); }
      catch {
        interpretation = { mode: "unavailable", policyId: gateway.policyId, failureStage: "model", reason: "修订模型尚未成功返回可读候选；本轮未应用修改，原话已保留。可检查模型配置或稍后重试。" };
        break; // Network and credential errors are not repaired by a formatting retry.
      }
      if (output.usage) usage = { inputTokens: (usage?.inputTokens ?? 0) + output.usage.inputTokens, outputTokens: (usage?.outputTokens ?? 0) + output.usage.outputTokens,
        estimatedCostUsd: (usage?.estimatedCostUsd ?? 0) + (output.usage.estimatedCostUsd ?? 0) };
      try {
        const proposal = ReviewReplyProposalSchema.parse(output.proposal);
        applyReviewReplyProposal(review, reply, answer, proposal);
        attempts.push({ status: "accepted" });
        interpretation = ReviewReplyInterpretationSchema.parse({ mode: "model", policyId: gateway.policyId, model: output.model, inputHash: reviewReplyInputHash(input), proposal, usage, attempts });
        break;
      } catch (error) {
        validationFeedback = (error instanceof Error ? error.message : "修订候选未通过检查").slice(0, 2400);
        attempts.push({ status: "rejected", reason: validationFeedback });
        if (attempt === 1) interpretation = { mode: "unavailable", policyId: gateway.policyId, failureStage: "candidate", reason: "修订候选经一次反馈修正后仍未通过原话、对象或分段覆盖核对；本轮未应用修改，原话已保留。请澄清或重试。" };
      }
    }
  }
  const parsed = replayReply(review, reply, answer, interpretation);
  const replyRecord = { freshTaskRef, conversationSha256: fresh.rawSha256, messageId: reply.id, quote: reply.text, meaning: "确认要求理解，不是验收通过" as const };
  const { contentHash: ignored, ...body } = review; void ignored;
  const child = seal({ ...body, reviewRef: randomUUID(), parentReviewRef: review.reviewRef, createdAt: new Date().toISOString(),
    lineageDepth: review.lineageDepth + 1,
    anchorConversationSha256: fresh.rawSha256, ...parsed, interpretation, reply: replyRecord, confirmation: parsed.status === "confirmed" ? replyRecord : undefined });
  await saveReview(dataDir, child);
  const receipt = { freshTaskRef, freshConversationSha256: fresh.rawSha256, childReviewRef: child.reviewRef };
  try { await writeFile(receiptPath(dataDir, review.reviewRef), JSON.stringify(receipt) + "\n", { flag: "wx" }); }
  catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    const winner = ReceiptSchema.parse(JSON.parse(await readFile(receiptPath(dataDir, review.reviewRef), "utf8")));
    if (winner.freshConversationSha256 !== fresh.rawSha256) throw new Error("This review has already consumed another reply");
    return readRequirementReview(dataDir, winner.childReviewRef);
  }
  return readRequirementReview(dataDir, child.reviewRef);
}

export async function readRequirementReview(dataDir: string, reviewRef: string): Promise<StoredRequirementReview> { return readReview(dataDir, reviewRef, new Set()); }
async function readReview(dataDir: string, reviewRef: string, visited: Set<string>): Promise<StoredRequirementReview> {
  RefSchema.parse(reviewRef);
  if (visited.has(reviewRef) || visited.size >= MAX_DEPTH) throw new Error("Requirement review lineage is cyclic or exceeds the bounded depth");
  visited.add(reviewRef);
  const review = ReviewSchema.parse(JSON.parse(await readFile(join(directory(dataDir), `${reviewRef}.json`), "utf8")));
  const { contentHash, ...body } = review;
  if (review.reviewRef !== reviewRef || hash(body) !== contentHash) throw new Error("Requirement review content hash mismatch");
  if (new Set(review.items.map(item => item.displayId)).size !== review.items.length || new Set(review.items.map(item => item.requirementId)).size !== review.items.length || new Set(review.unresolved.map(item => item.displayId)).size !== review.unresolved.length) throw new Error("Duplicate review identifiers");
  if (review.parentReviewRef) {
    const parent = await readReview(dataDir, review.parentReviewRef, visited);
    if (!review.reply) throw new Error("Derived review has no original user reply");
    const receipt = ReceiptSchema.parse(JSON.parse(await readFile(receiptPath(dataDir, parent.reviewRef), "utf8")));
    if (receipt.childReviewRef !== reviewRef || receipt.freshTaskRef !== review.reply.freshTaskRef || receipt.freshConversationSha256 !== review.reply.conversationSha256) throw new Error("Review reply receipt mismatch");
    for (const key of ["taskRef", "resolutionId", "baseConversationSha256", "taskRecordHash", "resolutionHash", "sessionId", "host"] as const) if (review[key] !== parent[key]) throw new Error("Review parent binding changed");
    if (review.lineageDepth !== parent.lineageDepth + 1) throw new Error("Review lineage depth changed");
    if (hash(review.materialIssues) !== hash(parent.materialIssues)) throw new Error("Review cannot clear original material issues");
    const task = await readTask(dataDir, review.reply.freshTaskRef), fresh = await readTaskIntake(dataDir, task);
    if (task.execution.kind !== "requirements_only" || fresh.rawSha256 !== review.reply.conversationSha256 || review.anchorConversationSha256 !== fresh.rawSha256) throw new Error("Review reply task source changed");
    const anchor = await readConversation(join(dataDir, "conversations", `${parent.anchorConversationSha256}.json`));
    if (anchor.rawSha256 !== parent.anchorConversationSha256) throw new Error("Review parent anchor changed");
    const validated = validateReply(parent, anchor, fresh);
    const expected = replayReply(parent, validated.reply, validated.answer, review.interpretation);
    if (validated.reply.id !== review.reply.messageId || validated.reply.text !== review.reply.quote || hash({ items: review.items, unresolved: review.unresolved, changes: review.changes, status: review.status }) !== hash(expected)) throw new Error("Review revision differs from original user reply");
    if ((review.status === "confirmed") !== Boolean(review.confirmation) || (review.confirmation && hash(review.confirmation) !== hash(review.reply))) throw new Error("Review confirmation binding changed");
  } else {
    const base = await baseMaterial(dataDir, review.taskRef, review.resolutionId);
    if (review.baseConversationSha256 !== base.intake.rawSha256 || review.anchorConversationSha256 !== base.anchorSha || review.taskRecordHash !== hash(base.task) || review.resolutionHash !== hash(base.resolution) || review.sessionId !== base.intake.conversation.sessionId || review.host !== base.intake.conversation.host) throw new Error("Review original task or resolution changed");
    const questions = initialQuestions(base.resolution, base.intake.conversation);
    if (hash(review.items) !== hash(initialItems(base.resolution)) || hash(review.unresolved) !== hash(questions) || hash(review.materialIssues) !== hash(base.issues) || review.status !== (questions.length ? "needs_clarification" : "awaiting_review") || review.lineageDepth !== 0 || review.reply || review.confirmation || review.interpretation || review.changes.length) throw new Error("Initial review does not match saved original requirements");
  }
  return review;
}

/** This is planning input only. It never changes the original Resolution or produces a verdict. */
export async function confirmedRequirementSnapshot(dataDir: string, reviewRef: string, currentTaskRef?: string) {
  const review = await readRequirementReview(dataDir, reviewRef);
  try {
    ReceiptSchema.parse(JSON.parse(await readFile(receiptPath(dataDir, reviewRef), "utf8")));
    throw new Error("This confirmed requirement version is superseded by a later review reply");
  } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  if (review.status !== "confirmed" || !review.confirmation || review.unresolved.some(item => !item.resolved)) throw new Error("Requirement understanding has not been completely confirmed");
  if (review.materialIssues.length) throw new Error("Original material is incomplete; understanding confirmation cannot authorize planning");
  const base = await baseMaterial(dataDir, review.taskRef, review.resolutionId);
  if (base.issues.length || base.resolution.unprocessedUserMessageIds.length || base.resolution.processing.some(item => item.status !== "processed")) throw new Error("Original material or requirement processing remains incomplete");
  if (!review.items.some(item => item.status === "active")) throw new Error("No active requirements remain for planning");
  let currentness: { currentness: "historical_version"; requiresFreshCaptureBeforePlanning: true } | { currentness: "checked_at_capture"; checkedConversationSha256: string; requiresFreshCaptureBeforePlanning: false } = { currentness: "historical_version", requiresFreshCaptureBeforePlanning: true };
  if (currentTaskRef) {
    const task = await readTask(dataDir, currentTaskRef), current = await readTaskIntake(dataDir, task);
    const anchor = await readConversation(join(dataDir, "conversations", `${review.anchorConversationSha256}.json`));
    const conversation = current.conversation, original = anchor.conversation.messages, ledger = conversation.hostCapture;
    if (task.execution.kind !== "requirements_only" || conversation.selectedScope || conversation.transcriptCoverage.source !== "host_adapter" || conversation.sessionId !== review.sessionId || conversation.host !== review.host) throw new Error("Currentness requires a same-session independent host capture");
    if (anchor.rawSha256 !== review.anchorConversationSha256 || current.structuralIssues.length || conversation.transcriptCoverage.missingMessageIds.length || (review.host === "codex-app-server" && (!ledger || !ledger.allReturnedPagesRead))) throw new Error("Currentness capture contains structural, pagination or missing-message gaps");
    if (conversation.transcriptCoverage.level !== "complete" && !(conversation.transcriptCoverage.level === "partial" && ledger?.scopeOnlyGap && ledger.allReturnedPagesRead)) throw new Error("Currentness capture history coverage is unknown");
    if (conversation.messages.length < original.length || original.some((item, index) => { const next = conversation.messages[index]; return !next || item.id !== next.id || item.sequence !== next.sequence || item.role !== next.role || item.text !== next.text; })) throw new Error("Currentness capture prefix differs from the confirmed review anchor");
    if (conversation.messages.slice(original.length).some(item => item.role === "user")) throw new Error("New user messages require review before this version can be treated as current");
    if (hash(conversation.materialGaps ?? []) !== hash(anchor.conversation.materialGaps ?? []) || hash(ledger?.unparsedUserContent ?? []) !== hash(anchor.conversation.hostCapture?.unparsedUserContent ?? [])) throw new Error("Currentness capture attachment or material ledger changed");
    currentness = { currentness: "checked_at_capture", checkedConversationSha256: current.rawSha256, requiresFreshCaptureBeforePlanning: false };
  }
  return { schemaVersion: 1 as const, kind: "confirmed_requirements_only" as const, reviewRef, reviewHash: review.contentHash, taskRef: review.taskRef,
    resolutionId: review.resolutionId, baseConversationSha256: review.baseConversationSha256, confirmation: review.confirmation,
    ...currentness, requirements: review.items.filter(item => item.status === "active"), meaning: "仅供后续生成验收计划；不是执行证据、业务执行授权，也不是验收通过。当前性只针对明确核对过的采集时点。" };
}
