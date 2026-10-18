import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ProjectHash } from "./project-profile.js";
import { sha256 } from "./storage.js";

const CommandSchema = z.object({
  exitCode: z.number().int().nullable(), signal: z.string().nullable(), stdout: z.string().max(1024 * 1024), stderr: z.string().max(1024 * 1024),
  timedOut: z.boolean(), aborted: z.boolean(), outputTruncated: z.boolean(), errorCode: z.string().optional(), durationMs: z.number().nonnegative(),
}).strict();
export const RuntimeReportSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("docker-runtime-check"), runnerVersion: z.literal("docker-runtime-v1"),
  runId: z.string().uuid(), projectRef: z.string().uuid(), projectRecordHash: ProjectHash, targetSnapshotHash: ProjectHash, profileSha256: ProjectHash,
  startedAt: z.string().datetime(), completedAt: z.string().datetime(),
  status: z.enum(["ready", "unavailable", "cancelled"]), verdict: z.literal("UNVERIFIABLE"),
  stage: z.enum(["configuration", "archive", "docker", "image", "create", "copy", "start", "readiness", "integrity"]),
  reason: z.string().max(2400), containerName: z.string().regex(/^vibeguard-[a-f0-9-]{36}$/),
  containerId: z.string().regex(/^[a-f0-9]{64}$/).optional(), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  stagingContainerId: z.string().regex(/^[a-f0-9]{64}$/).optional(), runtimeImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  runtimeImageRef: z.string().regex(/^vibeguard-runtime:[a-f0-9-]{36}$/).optional(),
  archive: z.object({ sha256: ProjectHash, bytes: z.number().int().nonnegative() }).strict().optional(),
  events: z.array(z.object({ step: z.string().max(80), args: z.array(z.string().max(16000)), result: CommandSchema }).strict()).max(240),
  cleanup: z.object({ status: z.enum(["not_needed", "removed", "incomplete"]), reason: z.string().max(1000) }).strict(),
  limitations: z.array(z.string().max(2000)),
}).strict();
export type RuntimeReport = z.infer<typeof RuntimeReportSchema>;
export function runtimeDirectory(dataDir: string, runId: string): string {
  z.string().uuid().parse(runId); return join(dataDir, "project-runtime", runId);
}
export async function saveRuntimeReport(dataDir: string, report: RuntimeReport): Promise<void> {
  const parsed = RuntimeReportSchema.parse(report), text = JSON.stringify(parsed, null, 2) + "\n", directory = runtimeDirectory(dataDir, parsed.runId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "report.json"), text, { flag: "wx", mode: 0o600 });
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, runId: parsed.runId, reportSha256: sha256(text) }) + "\n", { flag: "wx", mode: 0o600 });
}
export async function readRuntimeReport(dataDir: string, runId: string): Promise<RuntimeReport> {
  const directory = runtimeDirectory(dataDir, runId);
  const text = await readFile(join(directory, "report.json"), "utf8");
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("Runtime report exceeds 32 MiB");
  const manifest = z.object({ schemaVersion: z.literal(1), runId: z.string().uuid(), reportSha256: ProjectHash }).strict().parse(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
  const report = RuntimeReportSchema.parse(JSON.parse(text));
  if (report.runId !== runId || manifest.runId !== runId || manifest.reportSha256 !== sha256(text)) throw new Error("Runtime report integrity mismatch");
  return report;
}
