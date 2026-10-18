import { inspectConversation, type IntakeResult } from "./intake.js";
import { readSelectedScopeParent } from "./task-scope.js";

export const MATERIAL_POLICY_VERSION = "confirmed-context-attachments-text-candidates-v2";

/** This permits interpretation of text only. It never changes material coverage. */
export async function canInterpretPartialText(dataDir: string, intake: IntakeResult): Promise<boolean> {
  try { return await inspectPartialText(dataDir, intake); }
  catch { return false; } // Invalid or unreadable lineage stays blocked, never repaired here.
}

async function inspectPartialText(dataDir: string, intake: IntakeResult): Promise<boolean> {
  // Do not trust a caller to have kept the derived diagnostics up to date.
  intake = inspectConversation(intake.conversation, intake.rawSha256);
  const conversation = intake.conversation, scope = conversation.selectedScope, gaps = conversation.materialGaps;
  if (!scope || conversation.transcriptCoverage.level !== "partial" || conversation.transcriptCoverage.source !== "host_adapter" || conversation.transcriptCoverage.missingMessageIds.length || intake.structuralIssues.length || !gaps?.length) return false;
  const contextIds = new Set(scope.contextMessageIds), workIds = new Set(scope.workMessageIds);
  if (gaps.some(gap => gap.kind !== "unparsed_user_content" || !gap.count || !gap.messageIds.length || gap.messageIds.some(id => !contextIds.has(id) || workIds.has(id)))) return false;
  const parent = await readSelectedScopeParent(dataDir, conversation);
  const ledger = parent.conversation.hostCapture;
  if (parent.structuralIssues.length || parent.conversation.host !== "codex-app-server" || parent.conversation.transcriptCoverage.source !== "host_adapter" || parent.conversation.transcriptCoverage.missingMessageIds.length || !ledger?.allReturnedPagesRead || !ledger.scopeOnlyGap) return false;
  if (parent.conversation.materialGaps?.some(gap => gap.kind !== "unparsed_user_content")) return false;
  const selectedIds = new Set(conversation.messages.map(item => item.id));
  const expected = new Map(ledger.unparsedUserContent.filter(item => selectedIds.has(item.messageId)).map(item => [item.messageId, item.count]));
  if (!expected.size || [...expected.keys()].some(id => !contextIds.has(id))) return false;
  const accounted = new Set<string>();
  for (const gap of gaps) {
    let count = 0;
    for (const id of gap.messageIds) {
      if (accounted.has(id) || !expected.has(id)) return false;
      accounted.add(id); count += expected.get(id)!;
    }
    if (count !== gap.count) return false;
  }
  return accounted.size === expected.size;
}
