import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ConversationSchema, type Conversation } from "./intake.js";
import { sha256 } from "./storage.js";

const TraeBase = z.object({
  session_id: z.string().min(1),
  hook_event_name: z.enum(["SessionStart", "UserPromptSubmit", "Stop"]),
}).passthrough();

const CapturedEventSchema = z.object({
  eventId: z.string().uuid(),
  sessionKey: z.string().regex(/^[a-f0-9]{64}$/),
  sourceEvent: z.enum(["SessionStart", "UserPromptSubmit", "Stop"]),
  capturedAt: z.string().datetime(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().optional(),
});

type CapturedEvent = z.infer<typeof CapturedEventSchema>;

function sessionDirectory(dataDir: string, sessionId: string): string {
  return join(dataDir, "host-events", "trae", sha256(sessionId));
}

export async function captureTraeHook(raw: string, dataDir: string): Promise<{ eventId: string; sessionKey: string; sourceEvent: string }> {
  if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) throw new Error("Hook payload exceeds 1 MiB limit");
  const payload = TraeBase.parse(JSON.parse(raw));
  let text: string | undefined;
  if (payload.hook_event_name === "UserPromptSubmit") {
    text = z.object({ prompt: z.string().min(1) }).parse(payload).prompt;
  } else if (payload.hook_event_name === "Stop") {
    text = z.object({ last_assistant_message: z.string() }).parse(payload).last_assistant_message;
  }
  const event: CapturedEvent = {
    eventId: randomUUID(),
    sessionKey: sha256(payload.session_id),
    sourceEvent: payload.hook_event_name,
    capturedAt: new Date().toISOString(),
    sourceSha256: sha256(raw),
    ...(text === undefined ? {} : { text }),
  };
  const directory = sessionDirectory(dataDir, payload.session_id);
  await mkdir(directory, { recursive: true });
  const filename = `${process.hrtime.bigint().toString().padStart(20, "0")}-${event.eventId}.json`;
  await writeFile(join(directory, filename), JSON.stringify(event) + "\n", { flag: "wx" });
  return { eventId: event.eventId, sessionKey: event.sessionKey, sourceEvent: event.sourceEvent };
}

export async function exportTraeObservedConversation(dataDir: string, sessionId: string): Promise<Conversation> {
  if (!sessionId) throw new Error("Session ID is required");
  const directory = sessionDirectory(dataDir, sessionId);
  const files = (await readdir(directory)).filter(name => name.endsWith(".json")).sort();
  const events: CapturedEvent[] = [];
  for (const file of files) {
    const event = CapturedEventSchema.parse(JSON.parse(await readFile(join(directory, file), "utf8")));
    if (event.sessionKey !== sha256(sessionId)) throw new Error("Captured event belongs to a different session");
    events.push(event);
  }
  const messages = events.flatMap((event): Conversation["messages"] => {
    if (event.sourceEvent === "SessionStart" || !event.text) return [];
    return [{ id: event.eventId, sequence: 0, role: event.sourceEvent === "UserPromptSubmit" ? "user" : "assistant", text: event.text, timestamp: event.capturedAt }];
  }).map((message, index) => ({ ...message, sequence: index + 1 }));
  if (!messages.length) throw new Error("No user or assistant text has been captured for this session");
  return ConversationSchema.parse({
    schemaVersion: 1,
    taskId: `trae-observed-${sha256(sessionId).slice(0, 16)}`,
    sessionId,
    host: "trae-hook-observation",
    taskBoundary: { startMessageId: messages[0]!.id, endMessageId: messages[messages.length - 1]!.id },
    transcriptCoverage: {
      level: "partial",
      source: "host_adapter",
      basis: "仅记录已触发的 Trae SessionStart/UserPromptSubmit/Stop Hook。Stop 只有最后一条助手消息；未证明中间输出、工具事件、此前轮次及准确任务边界齐全。",
      missingMessageIds: [],
    },
    messages,
  });
}
