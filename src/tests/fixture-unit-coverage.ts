import { intentUnits } from "../intent-units.js";
import type { GatewayInput, Proposal } from "../requirements.js";

/** Only adapts pre-existing synthetic fixtures; never used for real model outputs. */
export function fixtureUnitCoverage(input: GatewayInput, proposal: Omit<Proposal, "unitDispositions">): Proposal {
  return { ...proposal, unitDispositions: intentUnits(input.messages).map(unit => {
    const ids = proposal.events.filter(event => [event.source, event.adoption].some(source => {
      if (!source || source.messageId !== unit.messageId) return false;
      const text = input.messages.find(message => message.id === source.messageId)!.text;
      const start = source.start ?? text.indexOf(source.quote);
      return start >= 0 && start < unit.end && unit.start < start + source.quote.length;
    })).map(event => event.requirementId);
    return { unitId: unit.unitId, kind: ids.length ? "requirement" as const : "context" as const, requirementIds: [...new Set(ids)], reason: "历史人工合成夹具的去向标注；不用于评估真实模型漏项" };
  }) };
}
