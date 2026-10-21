import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { checkExecutionCapture, ExecutionCaptureSchema } from "./execution-capture.js";
import { readExternalPlan } from "./external-plan.js";
import { sha256 } from "./storage.js";

const TicketSchema = z.object({ schemaVersion: z.literal(1), ticketRef: z.string().uuid(), planRef: z.string().uuid(),
  createdAt: z.number().int(), expiresAt: z.number().int(), collector: z.enum(["codex", "claude-code"]),
  toolUseId: z.string().min(1).max(500), scope: z.enum(["checkpoint", "final"]), capture: ExecutionCaptureSchema }).strict();
const file = (dataDir: string, ref: string) => { z.string().uuid().parse(ref); return join(dataDir, "execution-tickets", `${ref}.json`); };
const digest = (body: unknown) => sha256(JSON.stringify(body));

/** Called by the host collector, never a model tool. Local receipts do not resist same-account file forgery. */
export async function issueExecutionTicket(dataDir: string, planRef: string, taskRef: string, host: "codex" | "claude-code", sessionId: string, toolUseId: string, scope: "checkpoint" | "final") {
  const { record } = await readExternalPlan(dataDir, planRef), capture = await checkExecutionCapture(dataDir, record, taskRef);
  if (capture.sessionId !== sessionId || capture.host !== (host === "codex" ? "codex-app-server" : "claude-code-sdk") || !capture.acceptanceRequest) throw new Error("Host capture identity or standalone acceptance request is missing");
  const createdAt = Date.now(), body = TicketSchema.parse({ schemaVersion: 1, ticketRef: randomUUID(), planRef, createdAt, expiresAt: createdAt + 120000, collector: host, toolUseId, scope, capture });
  await mkdir(join(dataDir, "execution-tickets"), { recursive: true });
  await writeFile(file(dataDir, body.ticketRef), JSON.stringify({ body, sha256: digest(body) }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return body.ticketRef;
}

export async function consumeExecutionTicket(dataDir: string, ticketRef: string, planRef: string, taskRef: string | undefined, scope: "checkpoint" | "final") {
  const raw = await readFile(file(dataDir, ticketRef)); if (raw.length > 32768) throw new Error("Execution ticket exceeds limit");
  const envelope = z.object({ body: TicketSchema, sha256: z.string().length(64) }).strict().parse(JSON.parse(raw.toString("utf8")));
  const ticket = envelope.body;
  if (envelope.sha256 !== digest(ticket) || ticket.ticketRef !== ticketRef || ticket.planRef !== planRef || ticket.scope !== scope || ticket.capture.taskRef !== taskRef) throw new Error("Execution ticket input binding mismatch");
  const now = Date.now();
  if (now < ticket.createdAt || now > ticket.expiresAt || ticket.expiresAt - ticket.createdAt !== 120000) throw new Error("Execution ticket expired or has an invalid clock");
  // Exclusive claim is durable and prevents concurrent/restarted servers from replaying a ticket.
  await writeFile(join(dataDir, "execution-tickets", `${ticketRef}.used`), JSON.stringify({ claimedAt: now }) + "\n", { flag: "wx", mode: 0o600 });
  const current = await checkExecutionCapture(dataDir, (await readExternalPlan(dataDir, planRef)).record, ticket.capture.taskRef);
  if (current.conversationSha256 !== ticket.capture.conversationSha256 || current.acceptanceRequest?.messageId !== ticket.capture.acceptanceRequest?.messageId) throw new Error("Execution ticket source changed");
  return ticket;
}
