import { randomUUID } from "node:crypto";
import { z } from "zod";
import { chunkMessages, type ConversationMessage, type IntakeResult } from "./intake.js";
import type { SourceRef } from "./contracts.js";
import { attributedExternalRanges, expressesAdoption, overlapsRange } from "./provenance.js";
import { intentUnits, UnitDispositionSchema, validateUnitCoverage, type InterpretedUnit } from "./intent-units.js";

const SourceCandidateSchema = z.object({
  messageId: z.string().min(1),
  quote: z.string().min(1),
  start: z.number().int().nonnegative().optional(),
});

export const ProposalSchema = z.object({
  dispositions: z.array(z.object({
    messageId: z.string().min(1),
    kind: z.enum(["requirements", "authorization", "discussion", "unresolved"]),
    reason: z.string().min(1),
  })),
  events: z.array(z.discriminatedUnion("action", [
    z.object({ action: z.literal("add"), requirementId: z.string().regex(/^[a-z][a-z0-9-]*$/), normalized: z.string().min(1), source: SourceCandidateSchema, adoption: SourceCandidateSchema.nullish() }),
    z.object({ action: z.literal("replace"), requirementId: z.string().regex(/^[a-z][a-z0-9-]*$/), normalized: z.string().min(1), source: SourceCandidateSchema, adoption: SourceCandidateSchema.nullish() }),
    z.object({ action: z.literal("cancel"), requirementId: z.string().regex(/^[a-z][a-z0-9-]*$/), source: SourceCandidateSchema, adoption: SourceCandidateSchema.nullish() }),
  ])),
  unitDispositions: z.array(UnitDispositionSchema),
});

export type Proposal = z.infer<typeof ProposalSchema>;
export type RequirementStatus = "active" | "superseded" | "cancelled";

export interface RequirementRevision {
  requirementId: string;
  revision: number;
  status: RequirementStatus;
  normalized: string;
  sourceKind: "explicit_user" | "adopted_external";
  sourceRefs: SourceRef[];
}

export interface GatewayInput {
  taskId: string;
  messages: ConversationMessage[];
  knownRequirements: RequirementRevision[];
  validationFeedback?: string;
}

export interface GatewayOutput {
  proposal: Proposal;
  model: string;
  promptHash?: string;
  usage?: { inputTokens: number; outputTokens: number; estimatedCostUsd?: number };
}

export interface RequirementGateway {
  /** Changes invalidate cached extraction when prompt or policy changes. */
  readonly policyId?: string;
  propose(input: GatewayInput): Promise<GatewayOutput>;
}

export const REQUIREMENT_POLICY_VERSION = "intent-unit-coverage-v1";

export interface Resolution {
  schemaVersion: 1;
  resolutionId: string;
  taskId: string;
  createdAt: string;
  conversationSha256: string;
  transcriptCoverage: IntakeResult["conversation"]["transcriptCoverage"];
  coverageIssues: string[];
  revisions: RequirementRevision[];
  dispositions: Proposal["dispositions"];
  /** Absent in historical records; completeness is a structural check, not semantic proof. */
  interpretedUnits?: InterpretedUnit[];
  processing: { chunk: number; messageIds: string[]; status: "processed" | "failed"; model?: string; promptHash?: string; usage?: GatewayOutput["usage"]; rejectedClaims?: { messageId: string; requirementId: string; reason: string }[]; error?: string }[];
  unprocessedUserMessageIds: string[];
  resolutionComplete: boolean;
}

export async function resolveRequirements(intake: IntakeResult, gateway: RequirementGateway, maxChunkChars = 8000): Promise<Resolution> {
  const conversation = intake.conversation;
  const result: Resolution = {
    schemaVersion: 1,
    resolutionId: randomUUID(),
    taskId: conversation.taskId,
    createdAt: new Date().toISOString(),
    conversationSha256: intake.rawSha256,
    transcriptCoverage: conversation.transcriptCoverage,
    coverageIssues: [...intake.coverageIssues],
    revisions: [],
    dispositions: [],
    interpretedUnits: [],
    processing: [],
    unprocessedUserMessageIds: [...intake.userMessageIds],
    resolutionComplete: false,
  };
  let chunks: ConversationMessage[][];
  try {
    chunks = chunkMessages(conversation.messages, maxChunkChars);
  } catch (error) {
    result.coverageIssues.push(error instanceof Error ? error.message : String(error));
    return result;
  }
  for (const [index, messages] of chunks.entries()) {
    const userIds = messages.filter(message => message.role === "user").map(message => message.id);
    if (userIds.length === 0) continue;
    try {
      let output: GatewayOutput | undefined;
      let applied: ReturnType<typeof applyProposal> | undefined;
      let validationFeedback: string | undefined;
      let accumulatedUsage: GatewayOutput["usage"];
      for (let attempt = 0; attempt < 2; attempt++) {
        output = await gateway.propose({
          taskId: conversation.taskId,
          messages,
          knownRequirements: latestRequirements(result.revisions),
          validationFeedback,
        });
        if (output.usage) accumulatedUsage = {
          inputTokens: (accumulatedUsage?.inputTokens ?? 0) + output.usage.inputTokens,
          outputTokens: (accumulatedUsage?.outputTokens ?? 0) + output.usage.outputTokens,
          estimatedCostUsd: (accumulatedUsage?.estimatedCostUsd ?? 0) + (output.usage.estimatedCostUsd ?? 0),
        };
        try {
          applied = applyProposal(result.revisions, messages, ProposalSchema.parse(output.proposal));
          break;
        } catch (error) {
          validationFeedback = error instanceof Error ? error.message : String(error);
          if (attempt === 1) throw error;
        }
      }
      if (!output || !applied) throw new Error("No valid requirement proposal");
      result.revisions = applied.revisions;
      result.dispositions.push(...applied.dispositions);
      result.interpretedUnits!.push(...applied.interpretedUnits);
      result.processing.push({ chunk: index + 1, messageIds: messages.map(message => message.id), status: "processed", model: output.model, promptHash: output.promptHash, usage: accumulatedUsage, rejectedClaims: applied.rejectedClaims });
      const processed = new Set(applied.dispositions.map(item => item.messageId));
      result.unprocessedUserMessageIds = result.unprocessedUserMessageIds.filter(id => !processed.has(id));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      result.processing.push({ chunk: index + 1, messageIds: messages.map(message => message.id), status: "failed", error: detail });
      result.coverageIssues.push(`第 ${index + 1} 块要求整理失败：${detail}`);
      break;
    }
  }
  if (result.unprocessedUserMessageIds.length > 0) {
    result.coverageIssues.push(`未处理的用户消息：${result.unprocessedUserMessageIds.join(", ")}`);
  }
  if (result.dispositions.some(item => item.kind === "unresolved")) result.coverageIssues.push("存在尚未解释的用户消息");
  if (result.interpretedUnits?.some(unit => unit.kind === "unresolved")) result.coverageIssues.push("存在尚未解释的用户原文片段");
  result.resolutionComplete = result.coverageIssues.length === 0;
  return result;
}

export function currentRequirements(revisions: RequirementRevision[]): RequirementRevision[] {
  return latestRequirements(revisions).filter(revision => revision.status === "active");
}

function latestRequirements(revisions: RequirementRevision[]): RequirementRevision[] {
  const latest = new Map<string, RequirementRevision>();
  for (const revision of revisions) latest.set(revision.requirementId, revision);
  return [...latest.values()];
}

function applyProposal(existing: RequirementRevision[], messages: ConversationMessage[], proposal: Proposal): {
  revisions: RequirementRevision[];
  dispositions: Proposal["dispositions"];
  rejectedClaims: { messageId: string; requirementId: string; reason: string }[];
  interpretedUnits: InterpretedUnit[];
} {
  const userMessages = new Map(messages.filter(message => message.role === "user").map(message => [message.id, message]));
  const dispositionMap = new Map<string, Proposal["dispositions"][number]>();
  for (const disposition of proposal.dispositions) {
    if (!userMessages.has(disposition.messageId)) throw new Error(`Disposition references non-user or out-of-chunk message ${disposition.messageId}`);
    if (dispositionMap.has(disposition.messageId)) throw new Error(`Duplicate disposition for ${disposition.messageId}`);
    dispositionMap.set(disposition.messageId, disposition);
  }
  for (const id of userMessages.keys()) if (!dispositionMap.has(id)) throw new Error(`Missing disposition for user message ${id}`);
  const eventCounts = new Map<string, number>();
  const rejectedClaims: { messageId: string; requirementId: string; reason: string }[] = [];
  const staged = structuredClone(existing);
  const acceptedEvents: { requirementId: string; refs: SourceRef[] }[] = [];
  let lastSequence = -1;
  for (const event of proposal.events) {
    const message = userMessages.get(event.source.messageId);
    if (!message) throw new Error(`Event source ${event.source.messageId} is not a user message in this chunk`);
    if (message.sequence < lastSequence) throw new Error("Requirement events are not in message order");
    lastSequence = message.sequence;
    const ref = validateQuote(message, event.source);
    const externallyQuoted = overlapsRange(ref, attributedExternalRanges(message));
    let adoptionRef: SourceRef | undefined;
    if (externallyQuoted && event.adoption) {
      if (event.adoption.messageId !== message.id) throw new Error(`Adoption for ${event.requirementId} must cite the same user message`);
      adoptionRef = validateQuote(message, event.adoption);
      if (overlapsRange(adoptionRef, attributedExternalRanges(message)) || !expressesAdoption(adoptionRef.quote)) {
        rejectedClaims.push({ messageId: message.id, requirementId: event.requirementId, reason: "采纳依据不在引文之外，或不包含明确的用户决定" });
        continue;
      }
    }
    if (externallyQuoted && !adoptionRef) {
      rejectedClaims.push({ messageId: message.id, requirementId: event.requirementId, reason: "外部引文没有用户明确采纳的原话" });
      continue;
    }
    eventCounts.set(message.id, (eventCounts.get(message.id) ?? 0) + 1);
    const refs = adoptionRef ? [ref, adoptionRef] : [ref];
    acceptedEvents.push({ requirementId: event.requirementId, refs });
    const sourceKind = externallyQuoted ? "adopted_external" : "explicit_user";
    const previous = [...staged].reverse().find(revision => revision.requirementId === event.requirementId);
    if (event.action === "add") {
      if (previous) throw new Error(`Requirement ${event.requirementId} already exists`);
      staged.push({ requirementId: event.requirementId, revision: 1, status: "active", normalized: event.normalized, sourceKind, sourceRefs: refs });
      continue;
    }
    if (!previous || (event.action === "cancel" && previous.status !== "active")) {
      throw new Error(`Cannot ${event.action} inactive or unknown requirement ${event.requirementId}`);
    }
    previous.status = "superseded";
    staged.push({
      requirementId: event.requirementId,
      revision: previous.revision + 1,
      status: event.action === "cancel" ? "cancelled" : "active",
      normalized: event.action === "cancel" ? previous.normalized : event.normalized,
      sourceKind,
      sourceRefs: [...previous.sourceRefs, ...refs],
    });
  }
  const interpretedUnits = validateUnitCoverage(intentUnits(messages), proposal.unitDispositions);
  const dispositions = proposal.dispositions.map(disposition => ({ ...disposition }));
  for (const disposition of dispositions) {
    const count = eventCounts.get(disposition.messageId) ?? 0;
    if (disposition.kind === "requirements" && count === 0) {
      const restatesExisting = interpretedUnits.some(unit => unit.messageId === disposition.messageId && unit.kind === "requirement" && unit.requirementIds.some(id => existing.some(item => item.requirementId === id && item.status === "active")));
      if (!restatesExisting) {
        if (!rejectedClaims.some(item => item.messageId === disposition.messageId)) throw new Error(`Requirement message ${disposition.messageId} has no events`);
        disposition.kind = "unresolved";
        disposition.reason = `${disposition.reason}；候选要求仅引用未确认采纳的外部材料，需复核`;
      }
    }
    if (disposition.kind !== "requirements" && count !== 0) throw new Error(`Non-requirement message ${disposition.messageId} has requirement events`);
  }
  for (const unit of interpretedUnits) {
    if (unit.kind === "requirement" && unit.requirementIds.some(id => rejectedClaims.some(claim => claim.requirementId === id))) {
      unit.kind = "unresolved";
      unit.requirementIds = [];
      unit.reason += "；关联候选被来源门禁拒绝，需复核";
    }
    for (const id of unit.requirementIds) {
      if (unit.kind === "authorization") {
        const previouslyEstablished = existing.some(item => item.requirementId === id) || acceptedEvents.some(event => event.requirementId === id && event.refs.every(ref => {
          const source = userMessages.get(ref.messageId)!;
          const current = userMessages.get(unit.messageId)!;
          return source.sequence < current.sequence || (source.sequence === current.sequence && ref.end <= unit.start);
        }));
        if (!previouslyEstablished) throw new Error(`Authorization unit ${unit.unitId} cannot introduce requirement ${id}`);
      } else {
        // A neighboring clause can restate the same rule without duplicating an
        // event. Preserve that original too, while validating ID integrity.
        const related = staged.findLast(item => item.requirementId === id);
        if (!related) throw new Error(`Requirement unit ${unit.unitId} links to unknown requirement ${id}`);
        const ref = { messageId: unit.messageId, start: unit.start, end: unit.end, quote: unit.quote };
        if (overlapsRange(ref, attributedExternalRanges(userMessages.get(unit.messageId)!))) {
          if (!acceptedEvents.some(event => event.requirementId === id && event.refs.some(source => source.messageId === unit.messageId && overlapsRange(source, [unit])))) throw new Error(`External intent unit ${unit.unitId} needs an adopted source-linked event`);
        } else if (!related.sourceRefs.some(source => source.messageId === ref.messageId && source.start === ref.start && source.end === ref.end)) related.sourceRefs.push(ref);
      }
    }
    if (unit.kind === "authorization" && acceptedEvents.some(event => event.refs.some(ref => ref.messageId === unit.messageId && overlapsRange(ref, [unit])))) {
      throw new Error(`Authorization unit ${unit.unitId} cannot be the source of a requirement event`);
    }
  }
  for (const event of acceptedEvents) {
    if (!interpretedUnits.some(unit => unit.kind === "requirement" && unit.requirementIds.includes(event.requirementId) && event.refs.some(ref => ref.messageId === unit.messageId && overlapsRange(ref, [unit])))) {
      throw new Error(`Requirement event ${event.requirementId} has no matching intent unit`);
    }
  }
  for (const disposition of dispositions) {
    const units = interpretedUnits.filter(unit => unit.messageId === disposition.messageId);
    if (units.some(unit => unit.kind === "unresolved")) { disposition.kind = "unresolved"; disposition.reason += "；存在待确认原文片段"; }
    else if (disposition.kind === "authorization" && units.some(unit => unit.kind !== "authorization" && unit.kind !== "context")) throw new Error(`Authorization message ${disposition.messageId} has non-authorization units`);
    else if (disposition.kind === "discussion" && units.some(unit => unit.kind === "requirement")) throw new Error(`Discussion message ${disposition.messageId} has requirement units`);
  }
  return { revisions: staged, dispositions, rejectedClaims, interpretedUnits };
}

function validateQuote(message: ConversationMessage, candidate: Proposal["events"][number]["source"]): SourceRef {
  let start = candidate.start;
  if (start === undefined) {
    start = message.text.indexOf(candidate.quote);
    if (start < 0 || message.text.indexOf(candidate.quote, start + 1) >= 0) throw new Error(`Quote missing or repeated in ${message.id}; explicit start required`);
  }
  const end = start + candidate.quote.length;
  if (message.text.slice(start, end) !== candidate.quote) throw new Error(`Quote mismatch in ${message.id}`);
  return { messageId: message.id, start, end, quote: message.text.slice(start, end) };
}
