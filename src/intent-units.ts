import { z } from "zod";
import type { ConversationMessage } from "./intake.js";
import { attributedExternalRanges } from "./provenance.js";
import type { SourceRef } from "./contracts.js";

export interface IntentUnit extends SourceRef { unitId: string }

export const UnitDispositionSchema = z.object({
  unitId: z.string().min(1),
  kind: z.enum(["requirement", "authorization", "context", "unresolved"]),
  requirementIds: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)),
  reason: z.string().min(1),
});
export type UnitDisposition = z.infer<typeof UnitDispositionSchema>;
export type InterpretedUnit = IntentUnit & Omit<UnitDisposition, "unitId">;

/** Mechanical text boundaries, not an assertion that each segment is a requirement. */
export function intentUnits(messages: ConversationMessage[]): IntentUnit[] {
  const units: IntentUnit[] = [];
  for (const message of messages.filter(item => item.role === "user")) {
    const external = attributedExternalRanges(message);
    let start = 0;
    let number = 0;
    const append = (end: number) => {
      const quote = message.text.slice(start, end);
      if (quote.trim()) units.push({ unitId: `u${message.sequence}.${++number}`, messageId: message.id, start, end, quote });
      start = end;
    };
    for (let index = 0; index < message.text.length; index++) {
      const quoted = external.find(range => index >= range.start && index < range.end);
      if (quoted) {
        if (start < quoted.start) append(quoted.start);
        append(quoted.end);
        index = quoted.end - 1;
      } else if (/[，,；;。！？!?、\n\r]/u.test(message.text[index]!)) append(index + 1);
    }
    if (start < message.text.length) append(message.text.length);
  }
  return units;
}

export function validateUnitCoverage(units: IntentUnit[], dispositions: UnitDisposition[]): InterpretedUnit[] {
  const expected = new Map(units.map(unit => [unit.unitId, unit]));
  const found = new Map<string, UnitDisposition>();
  for (const disposition of dispositions) {
    if (!expected.has(disposition.unitId)) throw new Error(`Unknown intent unit ${disposition.unitId}`);
    if (found.has(disposition.unitId)) throw new Error(`Duplicate intent unit ${disposition.unitId}`);
    if (new Set(disposition.requirementIds).size !== disposition.requirementIds.length) throw new Error(`Duplicate requirement link for ${disposition.unitId}`);
    if (disposition.kind === "requirement" && !disposition.requirementIds.length) throw new Error(`Requirement unit ${disposition.unitId} has no requirement links`);
    if ((disposition.kind === "context" || disposition.kind === "unresolved") && disposition.requirementIds.length) throw new Error(`Non-requirement unit ${disposition.unitId} has requirement links`);
    found.set(disposition.unitId, disposition);
  }
  for (const unit of units) if (!found.has(unit.unitId)) throw new Error(`Missing intent unit ${unit.unitId}: ${unit.quote}`);
  return units.map(unit => ({ ...unit, ...found.get(unit.unitId)! }));
}
