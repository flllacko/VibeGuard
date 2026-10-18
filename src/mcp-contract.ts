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
}).strict().refine(input => !(input.taskSelection && input.requirementReview), {
  message: "不能在一次调用中同时选择任务范围和回复要求清单；请先完成当前步骤。",
});
