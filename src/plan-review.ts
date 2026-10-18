import { join } from "node:path";
import type { FileProfile, FileRef } from "./file-profile.js";
import { freezePlan, type FrozenPlan } from "./planning.js";
import { currentRequirements, type Resolution } from "./requirements.js";

/** A view of a validated plan, never an approval record or execution verdict. */
export function buildAcceptancePlan(plan: FrozenPlan, resolution: Resolution, profile?: FileProfile) {
  const validated = freezePlan(resolution, { criteria: plan.criteria, coverage: plan.coverage }, plan.source);
  if (validated.planHash !== plan.planHash || plan.conversationSha256 !== resolution.conversationSha256) throw new Error("计划与原始要求不一致，不能展示为当前验收清单。");
  const fileLocation = (ref: FileRef) => {
    const root = profile?.roots.find(item => item.rootId === ref.rootId);
    return root ? join(root.path, ref.path).replaceAll("\\", "/") : `${ref.rootId}/${ref.path || "（根本身）"}`;
  };
  return {
    schemaVersion: 1, planHash: plan.planHash, resolutionId: resolution.resolutionId,
    conversationSha256: plan.conversationSha256, status: "plan_definition",
    meaning: "这份清单描述验收范围和方法；是否已经执行及实际结论请查看对应运行报告。确认理解不等于验收通过，也不保证计划语义完整。",
    requirements: currentRequirements(resolution.revisions).map(requirement => {
      const coverage = plan.coverage.find(row => row.requirementId === requirement.requirementId)!;
      return { requirementId: requirement.requirementId, normalized: requirement.normalized, sourceRefs: requirement.sourceRefs,
        coverageStatus: coverage.status, ...(coverage.gapReason ? { gapReason: coverage.gapReason } : {}),
        criteria: plan.criteria.filter(criterion => coverage.criterionIds.includes(criterion.criterionId)).map(criterion => ({
          criterionId: criterion.criterionId, basis: criterion.sourceKind === "derived_check" ? "为取得证据补充的检查" : "对用户要求的验收标准",
          description: criterion.description, expected: criterion.expected, preconditions: criterion.preconditions,
          operations: criterion.checks.map(check => {
            if (check.type === "entry_exists") return `确认 ${fileLocation(check.target)} 存在，类型为${check.expectedKind === "file" ? "文件" : "目录"}`;
            if (check.type === "tree_compare") return `对照 ${fileLocation(check.reference)} → ${fileLocation(check.target)}：${check.comparison === "content" ? "完整结构和逐文件内容哈希" : "完整相对路径与文件/目录类型"}`;
            return check.steps.map(step => `${step.method} ${step.pathTemplate}（预期状态 ${step.expectedStatus}）`).join(" → ");
          }),
        })),
      };
    }),
  };
}
export type AcceptancePlan = ReturnType<typeof buildAcceptancePlan>;

export function renderAcceptancePlan(view: AcceptancePlan): string {
  const lines = ["# VibeGuard 准备检查什么", "", view.meaning, ""];
  for (const [index, requirement] of view.requirements.entries()) {
    lines.push(`## ${index + 1}. ${requirement.normalized}`, "", "用户原话：", "");
    // Keep every reference in the structured view, but do not print a smaller
    // excerpt again when a longer quote already covers it in the same message.
    const visibleRefs = requirement.sourceRefs.filter((ref, index, refs) => !refs.some((other, otherIndex) =>
      otherIndex !== index && other.messageId === ref.messageId && other.start <= ref.start && other.end >= ref.end &&
      (other.end - other.start > ref.end - ref.start || otherIndex < index)));
    for (const ref of visibleRefs) lines.push(...ref.quote.split("\n").map(line => `> ${line}`), "");
    for (const criterion of requirement.criteria) {
      lines.push(`${criterion.basis}：${criterion.description}`, "", `怎样算做到：${criterion.expected}`, "");
      for (const operation of criterion.operations) lines.push(`- ${operation}`);
      if (criterion.preconditions.length) lines.push("", "检查前需要：", ...criterion.preconditions.map(item => `- ${item}`));
      lines.push("");
    }
    if (requirement.gapReason) lines.push(`⚠ ${requirement.coverageStatus === "partial" ? "只能检查一部分" : "暂时没有可执行检查"}：${requirement.gapReason}`, "");
  }
  lines.push("如有理解错误，请指出哪条原话被遗漏、扩大或误解；修正要求或计划后应重新生成清单。", "", `计划编号：${view.planHash}`, `原文摘要：${view.conversationSha256}`, "");
  return lines.join("\n");
}
