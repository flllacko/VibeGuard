import type { Verdict } from "./contracts.js";
import type { FrozenPlan } from "./planning.js";
import type { HttpStepEvidence, PlannedRunReport } from "./plan-runner.js";
import { currentRequirements, type Resolution } from "./requirements.js";

export interface VerificationGap {
  stage: "planning" | "execution" | "precondition" | "lifecycle";
  reason: string;
  missingEvidence: string[];
  nextAction: string;
}

/** Derived from an already validated archived plan/run, never a model's coverage score. */
export function buildHttpCoverage(plan: FrozenPlan, resolution: Resolution, observations: HttpStepEvidence[],
  report: PlannedRunReport | undefined, lifecycle: { complete: boolean; reason: string }) {
  const requirements = currentRequirements(resolution.revisions).map(requirement => {
    const row = plan.coverage.find(item => item.requirementId === requirement.requirementId);
    if (!row) throw new Error(`Coverage diagnostic missing requirement ${requirement.requirementId}`);
    const criteria = plan.criteria.filter(item => row.criterionIds.includes(item.criterionId));
    const gaps: VerificationGap[] = [];
    if (row.status !== "planned") gaps.push({ stage: "planning", reason: row.gapReason!,
      missingEvidence: [`该要求尚无完整可执行检查：${requirement.normalized}`],
      nextAction: "补充所缺接口、运行条件或验收标准，重新生成计划后复验。" });
    const checks = criteria.flatMap(criterion => criterion.checks).map(check => {
      if (check.type !== "http_sequence") throw new Error("HTTP coverage cannot describe file checks");
      const result = report?.criteria.flatMap(item => item.checks).find(item => item.checkId === check.checkId);
      const steps = check.steps.map(step => {
        const observation = observations.find(item => item.checkId === check.checkId && item.stepId === step.stepId);
        return { stepId: step.stepId, operation: `${step.method} ${step.pathTemplate}`,
          state: observation?.error ? "tool_error" as const : observation?.response ? "response_received" as const : observation ? "tool_error" as const : "not_observed" as const,
          ...(observation ? { evidenceId: observation.evidenceId } : {}), ...(observation?.error ? { error: observation.error } : {}) };
      });
      const missing = steps.filter(step => step.state !== "response_received");
      if (missing.length) gaps.push({ stage: "execution", reason: result?.reason ?? "计划已有步骤，但尚未取得完整执行结果。",
        missingEvidence: missing.map(step => `${check.checkId}/${step.stepId} ${step.operation}：${step.error ?? "未取得响应"}`),
        nextAction: result?.verdict === "FAILED" ? "先修复已观察到的失败，再重新执行这组检查；失败后的未执行步骤不推测结果。" : "检查启动、工具错误或中断原因，恢复条件后重新执行该计划。" });
      return { checkId: check.checkId, verdict: result?.verdict ?? "UNVERIFIABLE" as Verdict, steps };
    });
    for (const criterion of criteria) if (criterion.preconditions.length) gaps.push({ stage: "precondition",
      reason: "存在尚未由执行步骤核对的前置条件。", missingEvidence: criterion.preconditions,
      nextAction: "为前置条件补充可观察的检查步骤，重新规划并执行。" });
    const outcome = report?.requirements.find(item => item.requirementId === requirement.requirementId);
    const verdict: Verdict = lifecycle.complete ? outcome?.verdict ?? "UNVERIFIABLE" : "UNVERIFIABLE";
    return { requirementId: requirement.requirementId, sourceRefs: requirement.sourceRefs, normalized: requirement.normalized,
      planningStatus: row.status, verdict, checks, gaps };
  });
  // A check can serve multiple requirements. Count actual step identities once.
  const unique = new Map(requirements.flatMap(item => item.checks).flatMap(check => check.steps.map(step => [`${check.checkId}/${step.stepId}`, step] as const)));
  const lifecycleGaps: VerificationGap[] = lifecycle.complete ? [] : [{ stage: "lifecycle", reason: lifecycle.reason,
    missingEvidence: ["完整结束且资源清理已确认的运行记录"], nextAction: "核对运行状态、启动或清理错误，再重新验收；已有片段仍可查看。" }];
  return { schemaVersion: 1, requirements, lifecycleGaps,
    counts: { totalRequirements: requirements.length, fullyPlannedRequirements: requirements.filter(item => item.planningStatus === "planned").length,
      verifiedRequirements: requirements.filter(item => item.verdict === "VERIFIED").length,
      failedRequirements: requirements.filter(item => item.verdict === "FAILED").length,
      unverifiableRequirements: requirements.filter(item => item.verdict === "UNVERIFIABLE").length,
      plannedSteps: unique.size, responseSteps: [...unique.values()].filter(step => step.state === "response_received").length },
    meaning: "计划条目和实际响应的客观账目；响应不等于断言满足，条目齐全不保证语义完整，不是置信度或正确率。" };
}
