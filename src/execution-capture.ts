import { z } from "zod";
import type { ExternalPlanRecord } from "./external-plan.js";
import { ProjectHash } from "./project-profile.js";
import { confirmedRequirementSnapshot, readRequirementReview } from "./requirement-review.js";
import { readTask } from "./task-registry.js";
import { readTaskIntake } from "./task-scope.js";
import { sha256 } from "./storage.js";
import { isAcceptanceCommand } from "./acceptance-command.js";

export const ExecutionCaptureSchema = z.object({
  schemaVersion: z.literal(1), status: z.literal("checked_at_capture"), checkedAt: z.string().datetime(),
  taskRef: z.string().uuid(), conversationSha256: ProjectHash, reviewRef: z.string().uuid(), reviewHash: ProjectHash,
  anchorConversationSha256: ProjectHash, sessionId: z.string().min(1), host: z.string().min(1),
  acceptanceRequest: z.object({ messageId: z.string().min(1), quote: z.string().refine(isAcceptanceCommand) }).strict().optional(),
}).strict();
export type ExecutionCapture = z.infer<typeof ExecutionCaptureSchema>;

/** A supplied capture is not proof that the host has no newer messages. */
export async function checkExecutionCapture(dataDir: string, plan: ExternalPlanRecord, taskRef: string | undefined): Promise<ExecutionCapture> {
  if (!taskRef) throw new Error("执行前必须提供本次独立采集的对话：project-run PLAN_REF --current-task TASK_REF。不会自动沿用准备项目时的旧快照。");
  const snapshot = await confirmedRequirementSnapshot(dataDir, plan.reviewRef, taskRef, { allowAcceptanceCommand: true });
  if (snapshot.currentness !== "checked_at_capture" || snapshot.reviewHash !== plan.reviewHash ||
    sha256(JSON.stringify(snapshot.requirements)) !== plan.requirementsSha256) throw new Error("执行时的采集与计划要求版本不一致，请重新审查和规划。");
  const review = await readRequirementReview(dataDir, plan.reviewRef);
  return ExecutionCaptureSchema.parse({ schemaVersion: 1, status: "checked_at_capture", checkedAt: new Date().toISOString(), taskRef,
    conversationSha256: snapshot.checkedConversationSha256, reviewRef: plan.reviewRef, reviewHash: plan.reviewHash,
    anchorConversationSha256: review.anchorConversationSha256, sessionId: review.sessionId, host: review.host,
    ...(snapshot.acceptanceRequest ? { acceptanceRequest: snapshot.acceptanceRequest } : {}) });
}

/** Historical reads check saved source/hash, never ask whether an old review is still the current head. */
export async function readArchivedExecutionCapture(dataDir: string, plan: ExternalPlanRecord, capture: ExecutionCapture | undefined) {
  if (!capture) return { status: "not_recorded" as const,
    meaning: "历史记录未保存执行时的独立对话核对；只能作为当时固定范围的报告，不能证明当前任务完成。" };
  if (capture.reviewRef !== plan.reviewRef || capture.reviewHash !== plan.reviewHash) throw new Error("Execution capture review binding mismatch");
  const task = await readTask(dataDir, capture.taskRef), intake = await readTaskIntake(dataDir, task);
  if (task.execution.kind !== "requirements_only" || intake.rawSha256 !== capture.conversationSha256 ||
    intake.conversation.sessionId !== capture.sessionId || intake.conversation.host !== capture.host ||
    intake.conversation.transcriptCoverage.source !== "host_adapter") throw new Error("Archived execution capture source changed");
  if (capture.acceptanceRequest) {
    const request = intake.conversation.messages.find(item => item.id === capture.acceptanceRequest!.messageId);
    if (!request || request.role !== "user" || request.text !== capture.acceptanceRequest.quote || !isAcceptanceCommand(request.text)) throw new Error("Archived acceptance command source changed");
  }
  return { ...capture, meaning: "已核对此次提交的独立采集快照；不证明平台此后没有新消息，也不保证调用方提交了实时最新历史。" };
}
