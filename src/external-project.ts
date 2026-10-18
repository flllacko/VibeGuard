import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { confirmedRequirementSnapshot } from "./requirement-review.js";
import { assertProjectStorageSeparated, ProjectHash, readProjectProfile, readStoredProjectProfile, saveProjectProfile } from "./project-profile.js";
import { captureProjectSnapshot, readProjectSnapshot } from "./project-snapshot.js";
import { readTask, TaskRecordSchema, type TaskRecord } from "./task-registry.js";
import { sha256 } from "./storage.js";

const PreparedProjectSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("external-project-prepared"), projectRef: z.string().uuid(), createdAt: z.string().datetime(),
  parentTaskRef: z.string().uuid(), projectId: z.string().min(1), profileSha256: ProjectHash,
  snapshotRef: z.string().uuid(), targetSnapshotHash: ProjectHash,
  reviewRef: z.string().uuid(), reviewHash: ProjectHash, currentTaskRef: z.string().uuid(),
  checkedConversationSha256: ProjectHash, requirementsSha256: ProjectHash, recordHash: ProjectHash,
}).strict();
export type PreparedProject = z.infer<typeof PreparedProjectSchema>;
const recordHash = ({ recordHash: ignored, ...record }: PreparedProject): string => { void ignored; return sha256(JSON.stringify(record)); };
type PreparedBody = Omit<PreparedProject, "recordHash">;

/** Explicit project configuration and a genuine confirmed source version are both required. */
export async function prepareExternalProject(dataDir: string, profilePath: string, reviewRef: string, currentTaskRef: string): Promise<{ task: TaskRecord; project: PreparedProject }> {
  const requirements = await confirmedRequirementSnapshot(dataDir, reviewRef, currentTaskRef);
  if (requirements.currentness !== "checked_at_capture") throw new Error("External projects require a current host capture");
  const profile = await readProjectProfile(profilePath);
  assertProjectStorageSeparated(dataDir, profile);
  const profileSha256 = await saveProjectProfile(dataDir, profile);
  const snapshot = await captureProjectSnapshot(dataDir, profile);
  const checked = await confirmedRequirementSnapshot(dataDir, reviewRef, currentTaskRef);
  if (JSON.stringify(requirements) !== JSON.stringify(checked)) throw new Error("Confirmed requirements changed during project preparation");
  const parent = await readTask(dataDir, requirements.taskRef);
  const body: PreparedBody = { schemaVersion: 1, kind: "external-project-prepared", projectRef: randomUUID(), createdAt: new Date().toISOString(),
    parentTaskRef: parent.taskRef, projectId: profile.projectId, profileSha256, snapshotRef: snapshot.snapshotRef, targetSnapshotHash: snapshot.snapshotHash,
    reviewRef, reviewHash: requirements.reviewHash, currentTaskRef, checkedConversationSha256: requirements.checkedConversationSha256!,
    requirementsSha256: sha256(JSON.stringify(requirements.requirements)) };
  const project = PreparedProjectSchema.parse({ ...body, recordHash: sha256(JSON.stringify(body)) });
  await mkdir(join(dataDir, "external-projects"), { recursive: true });
  await writeFile(join(dataDir, "external-projects", `${project.projectRef}.json`), JSON.stringify(project, null, 2) + "\n", { flag: "wx" });
  const task = TaskRecordSchema.parse({ ...parent, taskRef: randomUUID(), registeredAt: new Date().toISOString(),
    execution: { kind: "external_project", projectRef: project.projectRef, projectRecordHash: project.recordHash } });
  await mkdir(join(dataDir, "tasks"), { recursive: true });
  await writeFile(join(dataDir, "tasks", `${task.taskRef}.json`), JSON.stringify(task, null, 2) + "\n", { flag: "wx" });
  return { task, project };
}

/** Reads the frozen delivery, not an inferred latest workspace or an Agent's completion claim. */
export async function readExternalProject(dataDir: string, projectRef: string) {
  z.string().uuid().parse(projectRef);
  const project = PreparedProjectSchema.parse(JSON.parse(await readFile(join(dataDir, "external-projects", `${projectRef}.json`), "utf8")));
  if (project.projectRef !== projectRef || recordHash(project) !== project.recordHash) throw new Error("External project record hash mismatch");
  const requirements = await confirmedRequirementSnapshot(dataDir, project.reviewRef, project.currentTaskRef);
  if (requirements.currentness !== "checked_at_capture" || requirements.reviewHash !== project.reviewHash || requirements.taskRef !== project.parentTaskRef ||
    requirements.checkedConversationSha256 !== project.checkedConversationSha256 || sha256(JSON.stringify(requirements.requirements)) !== project.requirementsSha256) throw new Error("External project requirement binding changed");
  const profile = await readStoredProjectProfile(dataDir, project.profileSha256);
  if (profile.projectId !== project.projectId) throw new Error("External project profile binding changed");
  const snapshot = await readProjectSnapshot(dataDir, project.snapshotRef, profile);
  if (snapshot.snapshotHash !== project.targetSnapshotHash) throw new Error("External project delivery snapshot changed");
  return { project, profile, snapshot, requirements };
}

export async function inspectExternalProject(dataDir: string, projectRef: string) {
  const { project, profile, snapshot, requirements } = await readExternalProject(dataDir, projectRef);
  return { projectRef, projectId: project.projectId, status: "prepared_not_executed", kind: "external_project", verdict: "UNVERIFIABLE",
    profileSha256: project.profileSha256, snapshotRef: project.snapshotRef, targetSnapshotHash: snapshot.snapshotHash,
    snapshotCapturedAt: snapshot.capturedAt, sourceRoot: snapshot.sourceRoot,
    fileCount: snapshot.entries.filter(entry => entry.kind === "file").length, excluded: snapshot.excluded,
    reviewRef: project.reviewRef, requirements: requirements.requirements, currentness: "frozen_delivery_checked_at_capture",
    runtime: profile.runtime, missingEvidence: ["外部项目的验收执行计划", "隔离环境启动与就绪记录", "针对各项要求的实际执行证据"],
    meaning: "已保存交付副本并关联要求版本；没有执行项目或完成验收。原工作区后续修改不属于这份快照，需要重新准备。文件哈希不构成对同权限修改者的防伪保证。" };
}
