import { z } from "zod";
import { RefSchema } from "./task-registry.js";
import { TaskSelectionSchema } from "./task-scope.js";
import { RequirementReviewSelectionSchema } from "./requirement-review.js";

export const VerifyTaskInputSchema = z.object({
  taskRef: RefSchema.optional(),
  scope: z.enum(["checkpoint", "final"]).default("checkpoint"),
  forceRerun: z.boolean().default(false),
  taskSelection: TaskSelectionSchema.optional(),
  requirementReview: RequirementReviewSelectionSchema.optional(),
  externalPlanRef: RefSchema.optional(),
  captureTicket: RefSchema.optional(),
}).strict().refine(input => !(input.taskSelection && input.requirementReview), {
  message: "不能在一次调用中同时选择任务范围和回复要求清单；请先完成当前步骤。",
}).refine(input => !input.captureTicket || !!input.externalPlanRef, { message: "采集凭据只能用于指定的外部验收计划。" })
  .refine(input => !input.externalPlanRef || (!input.taskSelection && !input.requirementReview && !input.forceRerun), { message: "外部执行不能同时修订要求或强制重复运行；请先完成要求审查，复验时发送新的独立验收请求。" });
