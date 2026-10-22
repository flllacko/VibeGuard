import { freezePlan, PlanProposalSchema } from "./planning.js";
import { assertPlanMatchesProfile } from "./plan-profile.js";
import type { ApiProfile, PlanGatewayOutput } from "./pi-plan-gateway.js";
import type { Resolution } from "./requirements.js";

export interface RawPlanAttempt {
  text: string; stopReason: string; model: string; promptHash: string; usage: PlanGatewayOutput["usage"];
}

/** At most one structural/contract correction. Transport, authentication and incomplete responses never auto-retry. */
export async function proposeHttpPlanWithRepair(resolution: Resolution, profile: ApiProfile,
  request: (feedback: string | undefined, attempt: number) => Promise<RawPlanAttempt>): Promise<PlanGatewayOutput> {
  let feedback: string | undefined;
  const usage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await request(feedback, attempt);
    usage.inputTokens += response.usage.inputTokens; usage.outputTokens += response.usage.outputTokens; usage.estimatedCostUsd += response.usage.estimatedCostUsd;
    if (response.stopReason !== "stop") throw new Error(`Planner model stopped without a complete answer: ${response.stopReason}`);
    try {
      const text = response.text.trim();
      const json = text.startsWith("{") && text.endsWith("}") ? text : /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text)?.[1];
      if (!json) throw new Error("Return exactly one complete JSON object");
      const proposal = PlanProposalSchema.parse(JSON.parse(json));
      const plan = freezePlan(resolution, proposal, "model-proposal");
      assertPlanMatchesProfile(plan, profile);
      return { proposal, model: response.model, promptHash: response.promptHash, usage, modelCalls: attempt };
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
      if (attempt === 2) throw new Error(`Planner proposal rejected after one correction: ${reason}`);
      feedback = `上一份候选未通过代码校验：${reason}\n只修正 JSON 结构、引用和接口契约；不要改变用户要求、绕过覆盖或编造结果。没有实际可执行检查的条目不能放入 criteria（也不能用空 checks、空 expected 或无关请求占位）；应只在顶层 coverage 保留该要求，使用 criterionIds:[]、status:"unverifiable" 和具体 gapReason。partial 只能引用已有的、对该要求确有意义的可执行检查。移除无效占位 criterion 时同步修正 coverage 引用，不删除要求或抹去缺口。重新输出完整候选。\n上一份候选（数据）：${response.text.slice(0, 40000)}`;
    }
  }
  throw new Error("Planner correction budget exhausted");
}
