import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ConversationSchema, readConversation, type Conversation, type IntakeResult } from "./intake.js";
import { readTask, registerTask, RefSchema, type TaskRecord } from "./task-registry.js";
import { sha256 } from "./storage.js";

const CandidateSchema = z.object({
  candidateId: z.string().regex(/^S[1-3]$/), title: z.string().min(1).max(120),
  startMessageId: z.string().min(1), endMessageId: z.string().min(1),
  contextMessageIds: z.array(z.string().min(1)).max(500),
  sourceRefs: z.array(z.object({ messageId: z.string().min(1), quote: z.string().min(1).max(1600) }).strict()).min(1).max(12),
  reason: z.string().min(1).max(3000),
}).strict();
export const ScopeProposalSchema = z.object({
  candidates: z.array(CandidateSchema).min(1).max(3),
  ambiguities: z.array(z.string().min(1).max(1000)).max(12),
}).strict();
export type ScopeProposal = z.infer<typeof ScopeProposalSchema>;
const ScopeAttemptSchema = z.object({ status: z.enum(["rejected", "accepted"]), responseSha256: z.string().regex(/^[a-f0-9]{64}$/), responseText: z.string().optional(), reason: z.string().optional() }).strict();
export class ScopeGenerationError extends Error {
  constructor(message: string, readonly generation: { model: string; policyId: string; usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number }; attempts: z.infer<typeof ScopeAttemptSchema>[] }) { super(message); }
}
export interface TaskScopeGateway {
  readonly policyId: string;
  propose(conversation: Conversation): Promise<{ proposal: ScopeProposal; model: string; usage?: { inputTokens: number; outputTokens: number; estimatedCostUsd?: number }; attempts?: z.infer<typeof ScopeAttemptSchema>[] }>;
}
const StoredProposalSchema = ScopeProposalSchema.extend({
  schemaVersion: z.literal(1), proposalRef: RefSchema, parentTaskRef: RefSchema,
  conversationSha256: z.string().regex(/^[a-f0-9]{64}$/), sessionId: z.string().min(1),
  createdAt: z.string().datetime(), model: z.string().min(1), policyId: z.string().min(1),
  usage: z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), estimatedCostUsd: z.number().nonnegative().optional() }).optional(),
  attempts: z.array(ScopeAttemptSchema).optional(),
}).strict();
export type StoredScopeProposal = z.infer<typeof StoredProposalSchema>;
export const TaskSelectionSchema = z.object({ proposalRef: RefSchema, candidateId: z.string().regex(/^S[1-3]$/) }).strict();
export type TaskSelection = z.infer<typeof TaskSelectionSchema>;

export function scopeConfirmationReply(proposalRef: string, candidateId: string): string {
  RefSchema.parse(proposalRef);
  return `验收范围 ${candidateId} ${proposalRef.slice(0, 8)}`;
}

/** Models propose semantics. Code validates identity and exact quotes, never semantic completeness. */
export function validateScopeProposal(value: unknown, conversation: Conversation): ScopeProposal {
  const proposal = ScopeProposalSchema.parse(value);
  const messages = conversation.messages;
  const index = new Map(messages.map((message, position) => [message.id, position]));
  const ids = new Set<string>();
  for (const candidate of proposal.candidates) {
    if (ids.has(candidate.candidateId)) throw new Error("Duplicate scope candidate ID");
    ids.add(candidate.candidateId);
    const start = index.get(candidate.startMessageId), end = index.get(candidate.endMessageId);
    if (start === undefined || end === undefined || start > end || messages[start]!.role !== "user") throw new Error("Scope boundary must start with an original user message and preserve order");
    const context = new Set(candidate.contextMessageIds);
    if (context.size !== candidate.contextMessageIds.length) throw new Error("Duplicate scope context message");
    for (const id of context) {
      const position = index.get(id);
      if (position === undefined) throw new Error(`Scope context message ID does not exist: ${id}`);
      if (position >= start) throw new Error(`Scope context ${id} is at/after startMessageId ${candidate.startMessageId}; context must precede the work range, whose messages are already included`);
    }
    let workSource = false;
    for (const ref of candidate.sourceRefs) {
      const position = index.get(ref.messageId);
      const message = position === undefined ? undefined : messages[position];
      if (!message || message.role !== "user" || !message.text.includes(ref.quote)) throw new Error("Scope source must quote original user text exactly");
      if (position! >= start && position! <= end) workSource = true;
      else if (!context.has(ref.messageId)) throw new Error("Scope source is outside the proposed work and context");
    }
    if (!workSource) throw new Error("Scope candidate has no original user request within its work boundary");
  }
  return proposal;
}

export async function readTaskIntake(dataDir: string, task: TaskRecord): Promise<IntakeResult> {
  const intake = await readConversation(join(dataDir, "conversations", `${task.conversationSha256}.json`));
  if (intake.rawSha256 !== task.conversationSha256) throw new Error("Task conversation hash mismatch");
  return intake;
}

export async function proposeTaskScope(dataDir: string, task: TaskRecord, intake: IntakeResult, gateway: TaskScopeGateway): Promise<StoredScopeProposal> {
  if (intake.rawSha256 !== task.conversationSha256 || intake.conversation.transcriptCoverage.source === "agent_summary") throw new Error("Scope requires registered original conversation material");
  const directory = join(dataDir, "task-scopes");
  const cachePath = join(directory, `${sha256(JSON.stringify({ conversation: intake.rawSha256, policy: gateway.policyId }))}.cache.json`);
  try {
    const cached = z.object({ proposalRef: RefSchema }).strict().parse(JSON.parse(await readFile(cachePath, "utf8")));
    const stored = await readScopeProposal(dataDir, cached.proposalRef);
    if (stored.conversationSha256 !== intake.rawSha256 || stored.policyId !== gateway.policyId || stored.sessionId !== intake.conversation.sessionId) throw new Error("Scope cache binding changed");
    validateScopeProposal(proposalWithoutMetadata(stored), intake.conversation);
    return stored;
  } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  const output = await gateway.propose(intake.conversation);
  const proposal = validateScopeProposal(output.proposal, intake.conversation);
  const stored = StoredProposalSchema.parse({ ...proposal, schemaVersion: 1, proposalRef: randomUUID(), parentTaskRef: task.taskRef,
    conversationSha256: intake.rawSha256, sessionId: intake.conversation.sessionId, createdAt: new Date().toISOString(), model: output.model, policyId: gateway.policyId, usage: output.usage, attempts: output.attempts });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${stored.proposalRef}.json`), JSON.stringify(stored, null, 2) + "\n", { flag: "wx" });
  try { await writeFile(cachePath, JSON.stringify({ proposalRef: stored.proposalRef }) + "\n", { flag: "wx" }); }
  catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  return stored;
}

export async function readScopeProposal(dataDir: string, proposalRef: string): Promise<StoredScopeProposal> {
  RefSchema.parse(proposalRef);
  const stored = StoredProposalSchema.parse(JSON.parse(await readFile(join(dataDir, "task-scopes", `${proposalRef}.json`), "utf8")));
  if (stored.proposalRef !== proposalRef) throw new Error("Scope proposal reference mismatch");
  return stored;
}

export function scopeReview(proposal: StoredScopeProposal, conversation: Conversation): object {
  validateScopeProposal(proposalWithoutMetadata(proposal), conversation);
  const messages = conversation.messages;
  return {
    status: "needs_scope_confirmation", proposalRef: proposal.proposalRef, ambiguities: proposal.ambiguities,
    candidates: proposal.candidates.map(candidate => {
      const start = messages.findIndex(item => item.id === candidate.startMessageId), end = messages.findIndex(item => item.id === candidate.endMessageId);
      return { ...candidate, messageCount: end - start + 1, deliveryTextPresent: messages.slice(start, end + 1).some(item => item.role === "assistant"), startQuote: messages[start]!.text.slice(0, 500), endQuote: messages[end]!.text.slice(0, 500),
        context: candidate.contextMessageIds.map(id => { const message = messages.find(item => item.id === id)!; return { messageId: id, role: message.role, ...scopeExcerpt(message.text) }; }),
        confirmationReply: scopeConfirmationReply(proposal.proposalRef, candidate.candidateId) };
    }),
    meaning: "这是任务范围候选，不是完成证明。请展示任务名、起止原话、带入前文和疑点；用户可选择或要求调整。确认范围后仍需检查材料和实际执行证据。",
  };
}

function scopeExcerpt(text: string): { excerpt: string; excerptStart: number; excerptTruncated: boolean } {
  const request = text.indexOf("## My request:");
  const requestStart = request < 0 ? -1 : request + "## My request:".length;
  const annotation = /"annotation"\s*:\s*"/.exec(text);
  const start = requestStart >= 0 && text.slice(requestStart).trim() ? requestStart : annotation ? annotation.index + annotation[0].length : 0;
  return { excerpt: text.slice(start, start + 500), excerptStart: start, excerptTruncated: start > 0 || text.length > start + 500 };
}

function proposalWithoutMetadata(proposal: StoredScopeProposal): ScopeProposal { return { candidates: proposal.candidates, ambiguities: proposal.ambiguities }; }

function confirmationAnswer(text: string): string {
  const trimmed = text.trim();
  // The host records question answers as an original user message. Only the
  // actual single answer is accepted; pasted prose/quotes do not count.
  const wrapped = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(trimmed);
  if (!wrapped) return trimmed;
  try {
    const replies = z.array(z.object({ answer: z.string() }).passthrough()).length(1).parse(JSON.parse(wrapped[1]!));
    return replies[0]!.answer.trim();
  } catch { return ""; }
}

/** Confirmation is read from a later trusted capture, never a tool argument. */
export async function selectTaskScope(dataDir: string, currentTaskRef: string, selection: TaskSelection): Promise<TaskRecord> {
  TaskSelectionSchema.parse(selection);
  const proposal = await readScopeProposal(dataDir, selection.proposalRef);
  const parentTask = await readTask(dataDir, proposal.parentTaskRef), currentTask = await readTask(dataDir, currentTaskRef);
  if (parentTask.execution.kind !== "requirements_only" || currentTask.execution.kind !== "requirements_only") throw new Error("Existing execution plans must be regenerated for a changed task scope");
  const parent = await readTaskIntake(dataDir, parentTask), current = await readTaskIntake(dataDir, currentTask);
  const { candidate, original, confirmation } = validateScopeConfirmation(proposal, parent, current, selection);
  const start = original.findIndex(item => item.id === candidate.startMessageId), end = original.findIndex(item => item.id === candidate.endMessageId);
  const contextIds = new Set(candidate.contextMessageIds);
  const included = original.filter((message, index) => (index >= start && index <= end) || contextIds.has(message.id));
  const ledger = parent.conversation.hostCapture;
  const selectedIds = new Set(included.map(item => item.id));
  const missing = parent.conversation.transcriptCoverage.missingMessageIds;
  const parentComplete = parent.coverageIssues.length === 0;
  const sequenceAccounted = original[0]?.sequence === 1 && original.every((message, index) => message.sequence === index + 1) &&
    original[0]?.id === parent.conversation.taskBoundary.startMessageId && original.at(-1)?.id === parent.conversation.taskBoundary.endMessageId;
  const codexTextAccounted = parent.conversation.host === "codex-app-server" && ledger?.allReturnedPagesRead && ledger.scopeOnlyGap &&
    !ledger.unparsedUserContent.some(item => selectedIds.has(item.messageId)) && missing.length === 0 && sequenceAccounted;
  // A range choice cannot repair missing pages, unknown attachments or SDK
  // compaction. Only an explicit collector ledger can discharge a scope gap.
  const inheritedGaps = (parent.conversation.materialGaps ?? []).filter(gap => gap.kind === "missing_messages" || gap.messageIds.length === 0 || gap.messageIds.some(id => selectedIds.has(id)));
  const confirmationLedgerMissing = current.conversation.host === "codex-app-server" && !current.conversation.hostCapture;
  const complete = !confirmationLedgerMissing && (parentComplete || codexTextAccounted) && !ledger?.unparsedUserContent.some(item => selectedIds.has(item.messageId)) && inheritedGaps.length === 0;
  const materialGaps: NonNullable<Conversation["materialGaps"]> = structuredClone(inheritedGaps);
  const unparsed = ledger?.unparsedUserContent.filter(item => selectedIds.has(item.messageId)) ?? [];
  if (unparsed.length) {
    const count = unparsed.reduce((sum, item) => sum + item.count, 0);
    materialGaps.push({ kind: "unparsed_user_content", messageIds: unparsed.map(item => item.messageId), count,
      detail: `所选正文或带入前文中有 ${count} 项未解析的非文字用户内容。` });
  }
  if (missing.length) materialGaps.push({ kind: "missing_messages", messageIds: missing, detail: "原始材料声明缺少消息；确认范围不能补齐这些消息。" });
  if (!parentComplete && (!sequenceAccounted || parent.conversation.host !== "codex-app-server" || !ledger?.allReturnedPagesRead || !ledger.scopeOnlyGap)) {
    materialGaps.push({ kind: "history_coverage_unknown", messageIds: [], detail: "原材料的分页、消息顺序或内容完整性账目仍不充分；确认范围不能补齐这些记录。" });
  }
  if (confirmationLedgerMissing) materialGaps.push({ kind: "history_coverage_unknown", messageIds: [], detail: "确认回复的旧采集记录没有分页及非文字内容账目；仅保留范围选择，尚不能据此继续整理或验收。" });
  if (!complete && !materialGaps.length) materialGaps.push({ kind: "history_coverage_unknown", messageIds: [], detail: "原材料仍存在未明确定位的完整性缺口。" });
  const scoped = ConversationSchema.parse({
    schemaVersion: 1, taskId: `${parentTask.taskId}-scope-${selection.candidateId}`, sessionId: proposal.sessionId, host: parent.conversation.host,
    taskBoundary: { startMessageId: included[0]!.id, endMessageId: included.at(-1)!.id },
    transcriptCoverage: { level: complete ? "complete" : "partial", source: "host_adapter",
      basis: complete ? "用户选择了候选范围；仅对所选文字和带入前文，继承来源完整性声明或 Codex 全部分页及非文字内容账目。范围语义和是否漏选仍需审视；未执行任务检查。" : `验收范围已由原始用户回复确认。材料仍不足：${materialGaps.map(item => item.detail).join(" ")}`, missingMessageIds: missing },
    materialGaps,
    selectedScope: { proposalRef: proposal.proposalRef, candidateId: candidate.candidateId, title: candidate.title, parentConversationSha256: parent.rawSha256,
      workMessageIds: original.slice(start, end + 1).map(item => item.id), contextMessageIds: candidate.contextMessageIds,
      originalSequences: included.map(item => ({ messageId: item.id, sequence: item.sequence })),
      confirmation: { messageId: confirmation.id, quote: confirmation.text, conversationSha256: current.rawSha256 } },
    messages: included.map((message, index) => ({ ...message, sequence: index + 1 })),
  });
  const directory = join(dataDir, "task-scopes", proposal.proposalRef);
  await mkdir(directory, { recursive: true });
  const sourcePath = join(directory, `${randomUUID()}.json`);
  await writeFile(sourcePath, JSON.stringify(scoped, null, 2) + "\n", { flag: "wx" });
  return registerTask(dataDir, sourcePath, currentTask.scope);
}

function validateScopeConfirmation(proposal: StoredScopeProposal, parent: IntakeResult, current: IntakeResult, selection: TaskSelection) {
  if (parent.rawSha256 !== proposal.conversationSha256 || parent.conversation.sessionId !== proposal.sessionId) throw new Error("Scope proposal parent changed");
  validateScopeProposal(proposalWithoutMetadata(proposal), parent.conversation);
  if (current.conversation.sessionId !== proposal.sessionId || current.conversation.host !== parent.conversation.host || current.conversation.transcriptCoverage.source !== "host_adapter") throw new Error("Scope confirmation must come from a fresh capture of the same host session");
  if (current.structuralIssues.length || current.conversation.transcriptCoverage.missingMessageIds.length) throw new Error("Scope confirmation capture contains structural gaps or missing messages; an intervening user change cannot be ruled out");
  const confirmationLedger = current.conversation.hostCapture;
  if (current.conversation.host === "codex-app-server" && confirmationLedger && !confirmationLedger.allReturnedPagesRead) throw new Error("Scope confirmation capture has unread pages; an intervening user change cannot be ruled out");
  const original = parent.conversation.messages, fresh = current.conversation.messages;
  if (fresh.length <= original.length || original.some((message, index) => {
    const next = fresh[index]; return !next || message.id !== next.id || message.role !== next.role || message.text !== next.text || message.sequence !== next.sequence;
  })) throw new Error("Scope confirmation capture is stale or its original prefix changed");
  const users = fresh.slice(original.length).filter(item => item.role === "user");
  const confirmation = users[0];
  if (users.length !== 1 || !confirmation || confirmationAnswer(confirmation.text) !== scopeConfirmationReply(proposal.proposalRef, selection.candidateId) || fresh.at(-1)?.id !== confirmation.id) throw new Error("Need one new original user reply selecting this range; added requirements require a new proposal");
  if (confirmationLedger?.unparsedUserContent.some(item => item.messageId === confirmation.id) || current.conversation.materialGaps?.some(gap => gap.kind === "unparsed_user_content" && gap.messageIds.includes(confirmation.id))) throw new Error("Scope confirmation includes unparsed user content; it may contain additional requirements");
  const candidate = proposal.candidates.find(item => item.candidateId === selection.candidateId);
  if (!candidate) throw new Error("Unknown scope candidate");
  return { candidate, original, confirmation };
}

/** Re-read lineage before using a derived scope for anything beyond reporting. */
export async function readSelectedScopeParent(dataDir: string, selected: Conversation): Promise<IntakeResult> {
  const scope = selected.selectedScope;
  if (!scope) throw new Error("No confirmed scope provenance");
  const proposal = await readScopeProposal(dataDir, scope.proposalRef);
  const parent = await readTaskIntake(dataDir, await readTask(dataDir, proposal.parentTaskRef));
  const current = await readConversation(join(dataDir, "conversations", `${scope.confirmation.conversationSha256}.json`));
  if (current.rawSha256 !== scope.confirmation.conversationSha256 || parent.rawSha256 !== scope.parentConversationSha256) throw new Error("Selected scope source hash mismatch");
  const { candidate, original, confirmation } = validateScopeConfirmation(proposal, parent, current, { proposalRef: scope.proposalRef, candidateId: scope.candidateId });
  if (current.conversation.host === "codex-app-server" && !current.conversation.hostCapture) throw new Error("Legacy scope confirmation has no independent pagination or non-text ledger");
  if (confirmation.id !== scope.confirmation.messageId || confirmation.text !== scope.confirmation.quote || selected.sessionId !== proposal.sessionId || selected.host !== parent.conversation.host || scope.title !== candidate.title) throw new Error("Selected scope confirmation or identity changed");
  const start = original.findIndex(item => item.id === candidate.startMessageId), end = original.findIndex(item => item.id === candidate.endMessageId);
  const contextIds = new Set(candidate.contextMessageIds);
  const included = original.filter((message, index) => (index >= start && index <= end) || contextIds.has(message.id));
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (!equal(scope.workMessageIds, original.slice(start, end + 1).map(item => item.id)) || !equal(scope.contextMessageIds, candidate.contextMessageIds) ||
    !equal(scope.originalSequences, included.map(item => ({ messageId: item.id, sequence: item.sequence }))) ||
    !equal(selected.messages, included.map((message, index) => ({ ...message, sequence: index + 1 })))) throw new Error("Selected scope text or source mapping changed");
  return parent;
}

function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
