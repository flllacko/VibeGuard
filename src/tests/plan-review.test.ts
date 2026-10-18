import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { freezePlan } from "../planning.js";
import { buildAcceptancePlan, renderAcceptancePlan } from "../plan-review.js";
import { FileProfileSchema } from "../file-profile.js";
import type { Resolution } from "../requirements.js";

function fixture() {
  const quote = "保留所有素材。\n告诉我如何使用。";
  const resolution: Resolution = { schemaVersion: 1, resolutionId: randomUUID(), taskId: "readable", createdAt: new Date().toISOString(), conversationSha256: "a".repeat(64), transcriptCoverage: { level: "complete", source: "user_export", basis: "完整测试", missingMessageIds: [] }, coverageIssues: [], revisions: [
    { requirementId: "files", revision: 1, status: "active", normalized: "保留素材", sourceKind: "explicit_user", sourceRefs: [{ messageId: "u1", start: 0, end: quote.length, quote }] },
    { requirementId: "explain", revision: 1, status: "active", normalized: "告诉用户使用方式", sourceKind: "explicit_user", sourceRefs: [{ messageId: "u1", start: 8, end: quote.length, quote: "告诉我如何使用。" }] },
  ], dispositions: [], processing: [], unprocessedUserMessageIds: [], resolutionComplete: true };
  const plan = freezePlan(resolution, { criteria: [{ criterionId: "preserve", requirementIds: ["files"], sourceKind: "derived_check", description: "完整素材对照", preconditions: ["原始素材可读取"], expected: "完整目录和内容一致", checks: [{ checkId: "compare", type: "tree_compare", purpose: "核对素材", reference: { rootId: "original", path: "" }, target: { rootId: "delivered", path: "" }, comparison: "content" }] }], coverage: [{ requirementId: "files", criterionIds: ["preserve"], status: "planned" }, { requirementId: "explain", criterionIds: [], status: "unverifiable", gapReason: "还未接入交付文本验收" }] }, "manual-fixture");
  const profile = FileProfileSchema.parse({ schemaVersion: 1, profileId: "readable", description: "测试", roots: [{ rootId: "original", role: "reference", description: "原始素材", path: resolve("source") }, { rootId: "delivered", role: "delivery", description: "交付素材", path: resolve("target") }] });
  return { plan, resolution, profile, quote };
}

test("acceptance list preserves original quotes, separates derived checks and keeps unavailable requirements visible", () => {
  const f = fixture();
  const view = buildAcceptancePlan(f.plan, f.resolution, f.profile);
  assert.equal(view.requirements[0]!.sourceRefs[0]!.quote, f.quote);
  assert.equal(view.requirements[0]!.criteria[0]!.basis, "为取得证据补充的检查");
  assert.match(view.requirements[0]!.criteria[0]!.operations[0]!, /完整结构和逐文件内容哈希/);
  assert.equal(view.requirements[1]!.coverageStatus, "unverifiable");
  assert.equal(view.requirements[1]!.criteria.length, 0);
  const text = renderAcceptancePlan(view);
  assert.match(text, /> 保留所有素材。\n> 告诉我如何使用。/);
  assert.match(text, /怎样算做到：完整目录和内容一致/);
  assert.match(text, /暂时没有可执行检查：还未接入交付文本验收/);
  assert.equal("verdict" in view, false);
  assert.equal("approved" in view, false);
});

test("an acceptance list cannot be presented for changed requirements or a changed conversation binding", () => {
  const f = fixture();
  const changed = structuredClone(f.resolution);
  changed.revisions[0]!.normalized = "只保留部分素材";
  assert.throws(() => buildAcceptancePlan(f.plan, changed), /不一致/);
  changed.revisions = f.resolution.revisions;
  changed.conversationSha256 = "b".repeat(64);
  assert.throws(() => buildAcceptancePlan(f.plan, changed), /不一致/);
});
