import { z } from "zod";
import type { ConversationMessage } from "./intake.js";
import type { SourceRef } from "./contracts.js";
import { intentUnits } from "./intent-units.js";
import { attributedExternalRanges, overlapsRange } from "./provenance.js";
import type { StoredRequirementReview } from "./requirement-review.js";
import { sha256 } from "./storage.js";

const QuoteSchema = z.object({ quote: z.string().min(1), start: z.number().int().nonnegative().optional() }).strict();
const RequirementId = z.string().regex(/^R[1-9]\d*$/);
const QuestionId = z.string().regex(/^Q[1-9]\d*$/);
export const ReviewReplyProposalSchema = z.object({
  operations: z.array(z.discriminatedUnion("action", [
    z.object({ action: z.literal("replace"), target: RequirementId, normalized: z.string().trim().min(1).max(3000), source: QuoteSchema }).strict(),
    z.object({ action: z.literal("cancel"), target: RequirementId, source: QuoteSchema }).strict(),
    z.object({ action: z.literal("restore"), target: RequirementId, source: QuoteSchema }).strict(),
    z.object({ action: z.literal("add"), normalized: z.string().trim().min(1).max(3000), source: QuoteSchema }).strict(),
    z.object({ action: z.literal("merge"), targets: z.array(RequirementId).min(2).max(10), normalized: z.string().trim().min(1).max(3000).optional(), source: QuoteSchema }).strict(),
    z.object({ action: z.literal("clarify"), target: QuestionId, disposition: z.enum(["context", "requirement"]), normalized: z.string().trim().min(1).max(3000).optional(), source: QuoteSchema }).strict(),
  ])).max(30),
  confirmation: QuoteSchema.optional(),
  units: z.array(z.object({
    unitId: z.string().min(1), kind: z.enum(["operation", "confirmation", "context", "unresolved"]),
    operationIndexes: z.array(z.number().int().nonnegative()).default([]), reason: z.string().min(1).max(1000),
  }).strict()).max(500),
}).strict();
export type ReviewReplyProposal = z.infer<typeof ReviewReplyProposalSchema>;

export function reviewReplyInput(review: StoredRequirementReview, answer: string) {
  return {
    reviewRef: review.reviewRef, reviewHash: review.contentHash, answer,
    requirements: review.items.map(({ displayId, normalized, status }) => ({ displayId, normalized, status })),
    questions: review.unresolved.filter(item => !item.resolved).map(({ displayId, quote, reason }) => ({ displayId, quote, reason })),
    units: intentUnits([{ id: "reply", sequence: 1, role: "user", text: answer }]),
    attributedExternalRanges: attributedExternalRanges({ id: "reply", sequence: 1, role: "user", text: answer }),
  };
}
export type ReviewReplyInput = ReturnType<typeof reviewReplyInput>;
export interface ReviewReplyGateway {
  readonly policyId: string;
  propose(input: ReviewReplyInput, validationFeedback?: string): Promise<{ proposal: unknown; model: string; usage?: { inputTokens: number; outputTokens: number; estimatedCostUsd?: number } }>;
}
const UsageSchema = z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), estimatedCostUsd: z.number().nonnegative().optional() }).strict();
export const ReviewReplyInterpretationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("model"), policyId: z.string().min(1), model: z.string().min(1), inputHash: z.string().regex(/^[a-f0-9]{64}$/), proposal: ReviewReplyProposalSchema, usage: UsageSchema.optional(),
    attempts: z.array(z.object({ status: z.enum(["accepted", "rejected"]), reason: z.string().optional() }).strict()).max(2).optional(),
  }).strict(),
  z.object({ mode: z.literal("unavailable"), policyId: z.string().min(1), reason: z.string().min(1), failureStage: z.enum(["model", "candidate"]).optional() }).strict(),
]);
export type ReviewReplyInterpretation = z.infer<typeof ReviewReplyInterpretationSchema>;
export const reviewReplyInputHash = (input: ReviewReplyInput) => sha256(JSON.stringify(input));

type Patch = Pick<StoredRequirementReview, "items" | "unresolved" | "changes" | "status">;
const rawSource = (reply: ConversationMessage): SourceRef => ({ messageId: reply.id, start: 0, end: reply.text.length, quote: reply.text });

/** A model only proposes intent. The saved user text and current version bound every operation. */
export function applyReviewReplyProposal(review: StoredRequirementReview, reply: ConversationMessage, answer: string, candidate: unknown): Patch {
  const proposal = ReviewReplyProposalSchema.parse(candidate);
  const input = reviewReplyInput(review, answer), units = new Map(input.units.map(unit => [unit.unitId, unit]));
  const quoteRange = (citation: z.infer<typeof QuoteSchema>) => {
    const start = citation.start ?? answer.indexOf(citation.quote);
    if (start < 0 || answer.slice(start, start + citation.quote.length) !== citation.quote || (citation.start === undefined && answer.indexOf(citation.quote, start + 1) >= 0)) throw new Error("修订依据必须逐字引用这条真实用户回复；重复原话需要明确位置。");
    const range = { start, end: start + citation.quote.length };
    if (overlapsRange(range, input.attributedExternalRanges)) throw new Error("引用的助手或第三方文字不能冒充用户修订依据。");
    return range;
  };
  const operationRanges = proposal.operations.map(operation => quoteRange(operation.source));
  const confirmationRange = proposal.confirmation ? quoteRange(proposal.confirmation) : undefined;
  const classified = new Set<string>(), linkedOperations = new Set<number>();
  let confirmationUnits = 0;
  for (const disposition of proposal.units) {
    const unit = units.get(disposition.unitId);
    if (!unit || classified.has(disposition.unitId)) throw new Error("回复分段去向存在未知或重复编号。");
    classified.add(disposition.unitId);
    if (new Set(disposition.operationIndexes).size !== disposition.operationIndexes.length) throw new Error("回复分段重复关联修改操作。");
    if (disposition.kind === "operation") {
      if (!disposition.operationIndexes.length) throw new Error("修改片段没有关联操作。");
      for (const index of disposition.operationIndexes) {
        const range = operationRanges[index];
        if (!range || !overlapsRange(unit, [range])) throw new Error("修改操作没有对应的原话片段。");
        linkedOperations.add(index);
      }
    } else {
      if (disposition.operationIndexes.length) throw new Error("非修改片段不能关联修改操作。");
      if (disposition.kind === "confirmation") {
        if (!confirmationRange || !overlapsRange(unit, [confirmationRange])) throw new Error("确认片段没有真实用户确认依据。");
        confirmationUnits++;
      }
    }
  }
  if (classified.size !== units.size || linkedOperations.size !== proposal.operations.length) throw new Error("回复有未处理的原文或没有关联的修改操作。");
  if (Boolean(proposal.confirmation) !== (confirmationUnits > 0)) throw new Error("确认依据与回复片段去向不一致。");
  const items = structuredClone(review.items), unresolved = structuredClone(review.unresolved), changes: Patch["changes"] = [];
  const ref = rawSource(reply), touched = new Set<string>();
  const touch = (id: string) => { if (touched.has(id)) throw new Error("同一回复对同一条目提出多个操作，需要澄清。"); touched.add(id); };
  const refs = (...groups: SourceRef[][]) => groups.flat().filter((item, index, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(item)) === index);
  const newId = (prefix: string, entries: { displayId: string }[]) => `${prefix}${Math.max(0, ...entries.map(item => Number(item.displayId.slice(1)))) + 1}`;
  const add = (normalized: string, sourceRefs: SourceRef[]) => {
    const displayId = newId("R", items);
    items.push({ displayId, requirementId: `review-${review.reviewRef.slice(0, 8)}-${displayId.toLowerCase()}`, normalized, status: "active", sourceRefs });
    return displayId;
  };
  for (const operation of proposal.operations) {
    if (operation.action === "add") {
      const id = add(operation.normalized, [ref]);
      changes.push({ kind: "add", targets: [id], detail: `${id} 新增：${operation.normalized}`, source: ref }); continue;
    }
    if (operation.action === "clarify") {
      touch(operation.target);
      const question = unresolved.find(item => item.displayId === operation.target && !item.resolved);
      if (!question || (operation.disposition === "requirement") !== Boolean(operation.normalized)) throw new Error("澄清目标或转为要求的内容不合法。");
      question.resolved = true; question.disposition = operation.disposition; question.sourceRefs = refs(question.sourceRefs, [ref]);
      const targets = [question.displayId];
      if (operation.normalized) targets.push(add(operation.normalized, question.sourceRefs));
      changes.push({ kind: "clarify", targets, detail: `${question.displayId} ${operation.disposition === "context" ? "作为背景／本次不验" : "已转为要求"}`, source: ref }); continue;
    }
    if (operation.action === "merge") {
      if (new Set(operation.targets).size !== operation.targets.length) throw new Error("合并目标重复。");
      const targets = operation.targets.map(id => { touch(id); const item = items.find(entry => entry.displayId === id && entry.status === "active"); if (!item) throw new Error("合并目标不是当前有效要求。"); return item; });
      const first = targets[0]!;
      first.normalized = operation.normalized ?? targets.map(item => item.normalized).join("；"); first.sourceRefs = refs(...targets.map(item => item.sourceRefs), [ref]);
      for (const item of targets.slice(1)) { item.status = "cancelled"; item.sourceRefs = refs(item.sourceRefs, [ref]); }
      changes.push({ kind: "merge", targets: operation.targets, detail: `${operation.targets.join("、")} 合并到 ${first.displayId}：${first.normalized}`, source: ref }); continue;
    }
    touch(operation.target);
    const item = items.find(entry => entry.displayId === operation.target);
    if (!item || (operation.action === "restore" ? item.status !== "cancelled" : item.status !== "active")) throw new Error("修改对象的编号或当前状态不合法。");
    item.sourceRefs = refs(item.sourceRefs, [ref]);
    if (operation.action === "replace") item.normalized = operation.normalized;
    else item.status = operation.action === "cancel" ? "cancelled" : "active";
    changes.push({ kind: operation.action, targets: [item.displayId], detail: `${item.displayId} ${operation.action === "replace" ? `修改为：${item.normalized}` : operation.action === "cancel" ? "本次不验" : "恢复为当前要求"}`, source: ref });
  }
  for (const disposition of proposal.units.filter(unit => unit.kind === "unresolved")) {
    const unit = units.get(disposition.unitId)!, displayId = newId("Q", unresolved);
    unresolved.push({ displayId, sourceRefs: [ref], quote: unit.quote, reason: disposition.reason, resolved: false, disposition: "unresolved" });
    changes.push({ kind: "unknown", targets: [displayId], detail: `${displayId} 需要澄清：${disposition.reason}`, source: ref });
  }
  const status: Patch["status"] = unresolved.some(item => !item.resolved) ? "needs_clarification" : changes.length ? "awaiting_review" : proposal.confirmation ? "confirmed" : "awaiting_review";
  return { items, unresolved, changes, status };
}
