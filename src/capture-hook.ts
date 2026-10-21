import { isAbsolute } from "node:path";
import { z } from "zod";
import { captureCodexTask } from "./codex-history.js";
import { captureClaudeTask } from "./claude-history.js";
import { VerifyTaskInputSchema } from "./mcp-contract.js";
import { RefSchema } from "./task-registry.js";
import { issueExecutionTicket } from "./host-execution-ticket.js";

export type SupportedCollector = "codex" | "claude-code";
export interface CaptureHookOptions { host: SupportedCollector; dataDir: string; codexBin?: string }
export interface HookSession { sessionId: string; cwd: string; scope: "final" | "checkpoint" }
export type SessionCapture = (session: HookSession) => Promise<Record<string, unknown>>;
export type HookOutput = { hookSpecificOutput?: { hookEventName: "PreToolUse"; permissionDecision?: "allow" | "deny"; permissionDecisionReason?: string; updatedInput?: z.infer<typeof VerifyTaskInputSchema> } };

export const verificationToolName = "mcp__vibeguard__verify_task";
const HookPayload = z.object({ hook_event_name: z.literal("PreToolUse"), tool_name: z.literal(verificationToolName), session_id: z.string().uuid(), cwd: z.string().refine(isAbsolute, "Hook cwd must be absolute"), tool_input: z.unknown(), tool_use_id: z.string().min(1).max(500).optional() }).passthrough();

/** Run only before an explicit verify_task call, never on Stop or a timer. */
export async function prepareVerificationHook(raw: string, options: CaptureHookOptions, capture?: SessionCapture): Promise<HookOutput> {
  try {
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("Hook input exceeds 1 MiB");
    const payload = HookPayload.parse(JSON.parse(raw));
    const input = VerifyTaskInputSchema.parse(payload.tool_input);
    // User decisions are read from a fresh capture, never from tool arguments.
    if (input.taskRef && !input.taskSelection && !input.requirementReview && !input.externalPlanRef) return {};
    if (input.externalPlanRef && !payload.tool_use_id) throw new Error("External execution requires host tool invocation identity");
    const collect: SessionCapture = capture ?? (session => options.host === "codex"
      ? captureCodexTask(options.dataDir, session.sessionId, session.scope, options.codexBin)
      : captureClaudeTask(options.dataDir, session.sessionId, session.cwd, session.scope));
    const result = await collect({ sessionId: payload.session_id, cwd: payload.cwd, scope: input.scope });
    const taskRef = RefSchema.parse(result.taskRef);
    const captureTicket = input.externalPlanRef ? await issueExecutionTicket(options.dataDir, input.externalPlanRef, taskRef, options.host, payload.session_id, payload.tool_use_id!, input.scope) : undefined;
    return { hookSpecificOutput: {
      hookEventName: "PreToolUse",
      // Codex requires allow for updatedInput. Claude can rewrite while preserving approval.
      ...(options.host === "codex" ? { permissionDecision: "allow" as const } : {}),
      updatedInput: { ...input, taskRef, ...(captureTicket ? { captureTicket } : {}) },
    } };
  } catch {
    // Failures must be valid blocking JSON; exit-1/errors can fail open in hosts.
    // Do not echo raw input or filesystem errors, which may contain private data.
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "VibeGuard 未能取得可用于本次验收的当前会话材料；调用已停止。请核对采集权限、计划及材料完整性；有改口先完成审查。外部执行须独立发送“用 VibeGuard 验收”，手填旧 taskRef 不能替代采集。" } };
  }
}
