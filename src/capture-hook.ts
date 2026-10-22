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
  const failureReasons = {
    input: "[VG_INPUT] VibeGuard 钩子输入无效或缺少宿主调用身份，调用已停止。请检查平台接入；未开始采集或执行项目。",
    capture: "[VG_CAPTURE] VibeGuard 未能采集当前会话，调用已停止。请检查采集权限与平台读取能力；不会回退使用旧快照。",
    binding: "[VG_BINDING] VibeGuard 已取得当前会话快照，但无法绑定本次计划和已确认要求，调用已停止。请核对计划编号、要求版本及材料完整性；有改口先完成审查。外部执行须独立发送“用 VibeGuard 验收”，手填旧 taskRef 不能替代采集。",
  };
  let stage: keyof typeof failureReasons = "input";
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
    stage = "capture";
    const result = await collect({ sessionId: payload.session_id, cwd: payload.cwd, scope: input.scope });
    const taskRef = RefSchema.parse(result.taskRef);
    stage = "binding";
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
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: failureReasons[stage] } };
  }
}
