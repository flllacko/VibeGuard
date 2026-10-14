import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { readConversation, type IntakeResult } from "./intake.js";
import { freezePlan, type FrozenHttpPlan, type HttpPlanProposal as PlanProposal } from "./planning.js";
import type { Resolution, RequirementRevision } from "./requirements.js";
import type { SourceRef } from "./contracts.js";
import { sha256 } from "./storage.js";

export async function makeManualDemoPlan(): Promise<{ resolution: Resolution; plan: FrozenHttpPlan }> {
  const intake = await readConversation(fileURLToPath(new URL("../fixtures/conversations/coupon-complete.json", import.meta.url)));
  const u1 = source(intake, "u1", "订单满 100 元减 20 元");
  const u1Single = source(intake, "u1", "每张券只能使用一次");
  const u1Expiry = source(intake, "u1", "过期券不能用");
  const u2 = source(intake, "u2", "门槛改成满 150 元，其他规则不变。");
  const u3 = source(intake, "u3", "过期券这个要求先不做。");
  const revisions: RequirementRevision[] = [
    { requirementId: "threshold", revision: 1, status: "superseded", normalized: "订单满 100 元减 20 元", sourceKind: "explicit_user", sourceRefs: [u1] },
    { requirementId: "single-use", revision: 1, status: "active", normalized: "每张券只能使用一次", sourceKind: "explicit_user", sourceRefs: [u1Single] },
    { requirementId: "expiry", revision: 1, status: "superseded", normalized: "过期券不能用", sourceKind: "explicit_user", sourceRefs: [u1Expiry] },
    { requirementId: "threshold", revision: 2, status: "active", normalized: "订单满 150 元减 20 元", sourceKind: "explicit_user", sourceRefs: [u1, u2] },
    { requirementId: "expiry", revision: 2, status: "cancelled", normalized: "过期券不能用", sourceKind: "explicit_user", sourceRefs: [u1Expiry, u3] },
  ];
  const resolution: Resolution = {
    schemaVersion: 1,
    resolutionId: `manual-${intake.rawSha256.slice(0, 24)}`,
    taskId: intake.conversation.taskId,
    createdAt: new Date().toISOString(),
    conversationSha256: intake.rawSha256,
    transcriptCoverage: intake.conversation.transcriptCoverage,
    coverageIssues: intake.coverageIssues,
    revisions,
    dispositions: intake.userMessageIds.map(messageId => ({ messageId, kind: "requirements", reason: "人工样例预先标注" })),
    processing: [],
    unprocessedUserMessageIds: [],
    resolutionComplete: intake.coverageIssues.length === 0,
  };
  const proposal: PlanProposal = {
    criteria: [{
      criterionId: "threshold-boundary",
      requirementIds: ["threshold"],
      sourceKind: "derived_check",
      description: "150 元与 149 元对照检查",
      preconditions: ["每次使用不同的未用过优惠券"],
      expected: "150 元减 20 元；149 元不优惠",
      checks: [checkout("at-150", 15000, 2000), checkout("below-149", 14900, 0)],
    }],
    coverage: [
      { requirementId: "threshold", criterionIds: ["threshold-boundary"], status: "planned" },
      { requirementId: "single-use", criterionIds: [], status: "unverifiable", gapReason: "本轮未规划重复用券检查" },
    ],
  };
  return { resolution, plan: freezePlan(resolution, proposal, "manual-fixture") };
}

export async function demoSnapshotHash(variant: "correct" | "faulty" | "unavailable"): Promise<string> {
  const source = await readFile(new URL("./demo-app.js", import.meta.url));
  return sha256(Buffer.concat([source, Buffer.from(`\nvariant=${variant}`)]));
}

function checkout(checkId: string, amountCents: number, discountCents: number): PlanProposal["criteria"][number]["checks"][number] {
  return {
    checkId, type: "http_sequence", purpose: `${amountCents / 100} 元订单结算与持久化`, timeoutMs: 5000,
    steps: [
      { stepId: "checkout", method: "POST", pathTemplate: "/checkout", body: { amountCents, couponCode: checkId }, expectedStatus: 201, assertions: [], captures: [{ name: "order-id", pointer: "/orderId" }] },
      { stepId: "stored-order", method: "GET", pathTemplate: "/orders/{order-id}", expectedStatus: 200,
        assertions: [{ pointer: "/discountCents", equals: discountCents }, { pointer: "/totalCents", equals: amountCents - discountCents }], captures: [] },
    ],
  };
}

function source(intake: IntakeResult, messageId: string, quote: string): SourceRef {
  const message = intake.conversation.messages.find(item => item.id === messageId && item.role === "user");
  if (!message) throw new Error(`Missing user message ${messageId}`);
  const start = message.text.indexOf(quote);
  if (start < 0) throw new Error(`Missing quote in ${messageId}`);
  return { messageId, start, end: start + quote.length, quote: message.text.slice(start, start + quote.length) };
}
