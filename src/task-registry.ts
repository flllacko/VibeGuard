import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readConversation } from "./intake.js";
import { saveConversationCopy, readResolution } from "./resolution-storage.js";
import { readPlanRecord } from "./plan-storage.js";
import { readApiProfile } from "./pi-plan-gateway.js";
import { profileHash } from "./plan-profile.js";

export const RefSchema = z.string().uuid();
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const TaskRecordSchema = z.object({
  schemaVersion: z.literal(1),
  taskRef: RefSchema,
  taskId: z.string().min(1),
  registeredAt: z.string().datetime(),
  conversationSha256: HashSchema,
  scope: z.enum(["final", "checkpoint"]),
  execution: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("requirements_only") }).strict(),
    z.object({ kind: z.literal("controlled_demo"), planHash: HashSchema, profileSha256: HashSchema, variant: z.enum(["correct", "faulty", "unavailable"]) }).strict(),
  ]),
}).strict();
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const demoProfilePath = fileURLToPath(new URL("../fixtures/profiles/coupon-api.json", import.meta.url));
const demoConversationPath = fileURLToPath(new URL("../fixtures/conversations/coupon-complete.json", import.meta.url));

export async function registerTask(dataDir: string, conversationPath: string, scope: TaskRecord["scope"] = "final", demo?: { planHash: string; variant: "correct" | "faulty" | "unavailable" }): Promise<TaskRecord> {
  const intake = await readConversation(conversationPath);
  let execution: TaskRecord["execution"] = { kind: "requirements_only" };
  if (demo) {
    const controlled = await readConversation(demoConversationPath);
    if (intake.rawSha256 !== controlled.rawSha256) throw new Error("Controlled demo execution accepts only the bundled coupon conversation");
    const record = await readPlanRecord(dataDir, demo.planHash);
    const resolution = await readResolution(record.plan.resolutionId, dataDir);
    if (record.plan.conversationSha256 !== intake.rawSha256 || resolution.conversationSha256 !== intake.rawSha256) throw new Error("Demo plan does not match the registered conversation");
    const profileSha256 = profileHash(await readApiProfile(demoProfilePath));
    if (record.generation.profileSha256 !== profileSha256) throw new Error("Demo plan was frozen against a different API profile");
    execution = { kind: "controlled_demo", planHash: demo.planHash, profileSha256, variant: demo.variant };
  }
  const record = TaskRecordSchema.parse({ schemaVersion: 1, taskRef: randomUUID(), taskId: intake.conversation.taskId, registeredAt: new Date().toISOString(), conversationSha256: intake.rawSha256, scope, execution });
  await saveConversationCopy(intake, conversationPath, dataDir);
  const directory = join(dataDir, "tasks");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${record.taskRef}.json`), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  return record;
}

export async function readTask(dataDir: string, taskRef: string): Promise<TaskRecord> {
  RefSchema.parse(taskRef);
  const record = TaskRecordSchema.parse(JSON.parse(await readFile(join(dataDir, "tasks", `${taskRef}.json`), "utf8")));
  if (record.taskRef !== taskRef) throw new Error("Task reference mismatch");
  return record;
}
