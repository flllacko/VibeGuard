import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ConversationSchema, type Conversation } from "./intake.js";
import { saveHostSnapshot, type HostSnapshot } from "./host-snapshot.js";

export type ClaudeHistoryReader = (sessionId: string, options: { dir: string; includeSystemMessages: true }) => Promise<unknown>;
const SessionId = z.string().uuid();
const SessionMessage = z.object({ type: z.enum(["user", "assistant", "system"]), uuid: z.string().min(1), session_id: SessionId, message: z.unknown() }).passthrough();

/** The official SDK follows the saved message chain; no query/resume or model call. */
export async function readClaudeHistory(sessionId: string, cwd: string, reader: ClaudeHistoryReader = getSessionMessages): Promise<HostSnapshot> {
  SessionId.parse(sessionId);
  const records = z.array(SessionMessage).parse(await reader(sessionId, { dir: cwd, includeSystemMessages: true }));
  if (!records.length) throw new Error("Claude Code did not return a saved conversation for the current session and project");
  if (Buffer.byteLength(JSON.stringify(records)) > 50 * 1024 * 1024) throw new Error("Claude history exceeds 50 MiB; no messages were silently truncated");
  const seen = new Set<string>();
  const messages: Conversation["messages"] = [];
  let unsupportedUserParts = 0;
  let systemMessageCount = 0;
  for (const record of records) {
    if (record.session_id !== sessionId) throw new Error("Claude Code returned a different session");
    if (seen.has(record.uuid)) throw new Error("Claude Code returned a duplicate message ID");
    seen.add(record.uuid);
    if (record.type === "system") { systemMessageCount++; continue; }
    const message = z.object({ role: z.enum(["user", "assistant"]), content: z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough())]) }).passthrough().parse(record.message);
    if (message.role !== record.type) throw new Error("Claude message role differs from its record type");
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (record.type === "user") unsupportedUserParts += blocks.filter(block => block.type !== "text" && block.type !== "tool_result").length;
    // Tool results are stored in user-shaped SDK records. They are not human instructions.
    if (!blocks.some(block => block.type === "text") && !blocks.some(block => !["tool_result", "tool_use", "thinking", "redacted_thinking"].includes(block.type))) continue;
    const text = blocks.filter(block => block.type === "text").map(block => z.string().parse(block.text)).join("\n");
    messages.push({ id: record.uuid, sequence: messages.length + 1, role: record.type, text });
  }
  const lastUser = messages.findLastIndex(message => message.role === "user");
  if (lastUser < 0) throw new Error("Claude Code history has no user message");
  const bounded = messages.slice(0, lastUser + 1);
  const warnings = ["已读取 SDK 返回的当前消息链；任务起止范围尚未确认，也未证明压缩或分叉之前的全部原文齐全。"];
  if (unsupportedUserParts) warnings.push(`存在 ${unsupportedUserParts} 个未解析的非文字用户内容。`);
  const cutoff = bounded.at(-1)!.id;
  const conversation = ConversationSchema.parse({
    schemaVersion: 1, taskId: `claude-history-${sessionId}`, sessionId, host: "claude-code-sdk",
    taskBoundary: { startMessageId: bounded[0]!.id, endMessageId: cutoff },
    transcriptCoverage: { level: "partial", source: "host_adapter", basis: warnings.join(" "), missingMessageIds: [] }, messages: bounded,
  });
  return {
    conversation, raw: { sessionId, cwd, records },
    receipt: { sessionId, source: "official-sdk-session-read", sdkVersion: "0.3.285", sdkChainRead: true, recordCount: records.length, systemMessageCount, userMessageCount: bounded.filter(message => message.role === "user").length, assistantMessageCount: bounded.filter(message => message.role === "assistant").length, cutoffUserMessageId: cutoff, taskScopeConfirmed: false, transcriptCoverage: "partial", warnings },
  };
}

export async function captureClaudeTask(dataDir: string, sessionId: string, cwd: string, scope: "final" | "checkpoint", reader?: ClaudeHistoryReader): Promise<Record<string, unknown>> {
  return saveHostSnapshot(dataDir, "claude-code", await readClaudeHistory(sessionId, cwd, reader), scope);
}
