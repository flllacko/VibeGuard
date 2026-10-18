import { readFile } from "node:fs/promises";
import { z } from "zod";
import { sha256 } from "./storage.js";

export const MaterialGapSchema = z.object({
  kind: z.enum(["unparsed_user_content", "missing_messages", "history_coverage_unknown"]),
  messageIds: z.array(z.string().min(1)), detail: z.string().min(1),
  count: z.number().int().positive().optional(),
}).strict();

export const ConversationSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  host: z.string().min(1),
  taskBoundary: z.object({ startMessageId: z.string().min(1), endMessageId: z.string().min(1) }),
  transcriptCoverage: z.object({
    level: z.enum(["complete", "partial", "unknown"]),
    source: z.enum(["user_export", "host_adapter", "agent_summary"]),
    basis: z.string().min(1),
    missingMessageIds: z.array(z.string()).default([]),
  }),
  hostCapture: z.object({
    allReturnedPagesRead: z.boolean(),
    scopeOnlyGap: z.boolean(),
    unparsedUserContent: z.array(z.object({ messageId: z.string().min(1), count: z.number().int().positive() })),
  }).optional(),
  materialGaps: z.array(MaterialGapSchema).optional(),
  selectedScope: z.object({
    proposalRef: z.string().uuid(), candidateId: z.string().regex(/^S[1-3]$/), title: z.string().min(1),
    parentConversationSha256: z.string().regex(/^[a-f0-9]{64}$/),
    workMessageIds: z.array(z.string().min(1)).min(1), contextMessageIds: z.array(z.string().min(1)),
    originalSequences: z.array(z.object({ messageId: z.string().min(1), sequence: z.number().int().positive() })),
    confirmation: z.object({ messageId: z.string().min(1), quote: z.string().min(1), conversationSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  }).optional(),
  messages: z.array(z.object({
    id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    role: z.enum(["user", "assistant", "system", "tool"]),
    text: z.string(),
    timestamp: z.string().datetime().nullable().optional(),
  })).min(1),
});

export type Conversation = z.infer<typeof ConversationSchema>;
export type ConversationMessage = Conversation["messages"][number];

export interface IntakeResult {
  conversation: Conversation;
  rawSha256: string;
  coverageIssues: string[];
  structuralIssues: string[];
  userMessageIds: string[];
}

export async function readConversation(path: string): Promise<IntakeResult> {
  const raw = await readFile(path);
  if (raw.byteLength > 10 * 1024 * 1024) throw new Error("Conversation exceeds 10 MiB input limit; no messages were silently truncated");
  const parsed = ConversationSchema.parse(JSON.parse(raw.toString("utf8")));
  return inspectConversation(parsed, sha256(raw));
}

export function inspectConversation(conversation: Conversation, rawSha256 = sha256(JSON.stringify(conversation))): IntakeResult {
  const seen = new Set<string>();
  const issues: string[] = [];
  const structuralIssues: string[] = [];
  const structureIssue = (detail: string) => { issues.push(detail); structuralIssues.push(detail); };
  for (const message of conversation.messages) {
    if (seen.has(message.id)) throw new Error(`Duplicate message ID: ${message.id}`);
    seen.add(message.id);
  }
  const messages = conversation.messages;
  if (messages[0]?.id !== conversation.taskBoundary.startMessageId ||
    messages[messages.length - 1]?.id !== conversation.taskBoundary.endMessageId) {
    structureIssue("任务边界与首尾消息不一致");
  }
  for (let i = 1; i < messages.length; i++) {
    const previous = messages[i - 1]!;
    const current = messages[i]!;
    if (current.sequence <= previous.sequence) throw new Error("Message sequence must be strictly increasing");
    if (current.sequence !== previous.sequence + 1) structureIssue(`消息序号 ${previous.sequence} 与 ${current.sequence} 之间存在缺口`);
  }
  const coverage = conversation.transcriptCoverage;
  if (coverage.level !== "complete") issues.push(`材料完整性声明为 ${coverage.level}`);
  if (coverage.source === "agent_summary") issues.push("材料来自干活 Agent 的摘要，不能证明完整任务对话");
  if (coverage.missingMessageIds.length > 0) issues.push(`声明缺少消息：${coverage.missingMessageIds.join(", ")}`);
  if (messages[0]?.sequence !== 1) structureIssue("任务首条消息序号不是 1，可能缺少前文");
  const userMessageIds = messages.filter(message => message.role === "user").map(message => message.id);
  if (userMessageIds.length === 0) structureIssue("任务边界内没有用户消息");
  for (const gap of conversation.materialGaps ?? []) issues.push(gap.detail);
  if (conversation.hostCapture) {
    const unparsed = conversation.hostCapture.unparsedUserContent.map(item => item.messageId);
    if (new Set(unparsed).size !== unparsed.length || unparsed.some(id => !userMessageIds.includes(id))) throw new Error("Invalid host non-text content ledger");
  }
  if (conversation.selectedScope) {
    const scope = conversation.selectedScope;
    const included = [...scope.workMessageIds, ...scope.contextMessageIds];
    if (new Set(included).size !== included.length || included.length !== messages.length || included.some(id => !seen.has(id))) structureIssue("所选范围的正文与前文映射不一致");
    if (scope.originalSequences.length !== messages.length || scope.originalSequences.some((entry, index) => entry.messageId !== messages[index]?.id || (index > 0 && entry.sequence <= scope.originalSequences[index - 1]!.sequence))) structureIssue("所选范围缺少原始消息序号映射");
  }
  return { conversation, rawSha256, coverageIssues: issues, structuralIssues, userMessageIds };
}

export function chunkMessages(messages: ConversationMessage[], maxChars: number): ConversationMessage[][] {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new Error("maxChars must be a positive integer");
  const chunks: ConversationMessage[][] = [];
  let current: ConversationMessage[] = [];
  let size = 0;
  for (const message of messages) {
    if (message.text.length > maxChars) throw new Error(`Message ${message.id} exceeds chunk budget; no text was truncated`);
    if (current.length && size + message.text.length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(message);
    size += message.text.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
