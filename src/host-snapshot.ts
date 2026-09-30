import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Conversation } from "./intake.js";
import { registerTask } from "./task-registry.js";
import { sha256 } from "./storage.js";

export interface HostSnapshot {
  conversation: Conversation;
  receipt: Record<string, unknown>;
  raw: unknown;
}

/** Shared storage, not a proof that the host supplied a complete task. */
export async function saveHostSnapshot(dataDir: string, host: "codex" | "claude-code", capture: HostSnapshot, scope: "final" | "checkpoint"): Promise<Record<string, unknown>> {
  const captureId = randomUUID();
  const directory = join(dataDir, "host-snapshots", host, captureId);
  const raw = JSON.stringify(capture.raw);
  const conversation = JSON.stringify(capture.conversation, null, 2) + "\n";
  if (Buffer.byteLength(raw) > 50 * 1024 * 1024) throw new Error("Host history exceeds 50 MiB; capture was not silently truncated");
  const receipt = { ...capture.receipt, schemaVersion: 1, host, captureId, capturedAt: new Date().toISOString(), rawSha256: sha256(raw), conversationSha256: sha256(conversation) };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "raw.json"), raw, { flag: "wx" });
  await writeFile(join(directory, "conversation.json"), conversation, { flag: "wx" });
  await writeFile(join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  const task = await registerTask(dataDir, join(directory, "conversation.json"), scope);
  return { ...receipt, taskRef: task.taskRef, scope, storedAt: directory };
}
