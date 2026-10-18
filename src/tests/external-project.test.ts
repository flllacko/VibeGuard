import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ProjectProfileSchema, assertProjectStorageSeparated, type ProjectProfile } from "../project-profile.js";
import { captureProjectSnapshot, readProjectSnapshot, projectSnapshotDirectory } from "../project-snapshot.js";
import { inspectExternalProject, prepareExternalProject } from "../external-project.js";
import { registerTask } from "../task-registry.js";
import { ConversationSchema, type Conversation } from "../intake.js";
import { intentUnits } from "../intent-units.js";
import { saveResolution } from "../resolution-storage.js";
import type { Resolution } from "../requirements.js";
import { applyRequirementReviewReply, createRequirementReview, requirementReviewView } from "../requirement-review.js";
import { VerificationService } from "../verification-service.js";

const execute = promisify(execFile);
async function temporary(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-external-"));
  try { await action(directory); }
  finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
}
async function projectFixture(directory: string) {
  const dataDir = join(directory, "data"), root = join(directory, "delivery");
  await mkdir(dataDir); await mkdir(root);
  await writeFile(join(root, "package.json"), '{"name":"synthetic-external-delivery","type":"module"}');
  await writeFile(join(root, "server.mjs"), 'throw new Error("preparation must not execute this file");\n');
  const profile = ProjectProfileSchema.parse({ schemaVersion: 1, projectId: "text-service", description: "Synthetic external preparation fixture, not a live task",
    projectRoot: root, runtime: { kind: "docker", image: "node:24-bookworm-slim", command: ["node", "server.mjs"], containerPort: 3000, readiness: { path: "/health" } } });
  const profilePath = join(directory, "project.json"); await writeFile(profilePath, JSON.stringify(profile));
  return { dataDir, root, profile, profilePath };
}
async function sourceTask(dataDir: string, conversation: Conversation) {
  const path = join(dataDir, `${randomUUID()}.source.json`); await writeFile(path, JSON.stringify(conversation));
  return registerTask(dataDir, path);
}
/** Synthetic host messages exercise the actual review checks; they are not live human evidence. */
async function confirmedFixture(dataDir: string) {
  const quote = "增加文本转换功能。";
  const conversation = ConversationSchema.parse({ schemaVersion: 1, taskId: "synthetic-external-task", sessionId: "synthetic-external-session", host: "synthetic-test-host",
    taskBoundary: { startMessageId: "u1", endMessageId: "u1" }, transcriptCoverage: { level: "complete", source: "user_export", basis: "Synthetic test material", missingMessageIds: [] },
    messages: [{ id: "u1", role: "user", text: quote, sequence: 1 }] });
  const original = await sourceTask(dataDir, conversation);
  const resolution: Resolution = { schemaVersion: 1, resolutionId: randomUUID(), taskId: conversation.taskId, createdAt: new Date().toISOString(),
    conversationSha256: original.conversationSha256, transcriptCoverage: conversation.transcriptCoverage, coverageIssues: [],
    revisions: [{ requirementId: "text-conversion", revision: 1, status: "active", normalized: quote, sourceKind: "explicit_user", sourceRefs: [{ messageId: "u1", start: 0, end: quote.length, quote }] }],
    dispositions: [{ messageId: "u1", kind: "requirements", reason: "synthetic" }],
    interpretedUnits: intentUnits(conversation.messages).map(unit => ({ ...unit, kind: "requirement", requirementIds: ["text-conversion"], reason: "synthetic" })),
    processing: [{ chunk: 1, messageIds: ["u1"], status: "processed", model: "fixture-no-model-call" }], unprocessedUserMessageIds: [], resolutionComplete: true };
  await saveResolution(resolution, dataDir);
  const draft = await createRequirementReview(dataDir, original.taskRef, resolution.resolutionId);
  const fresh = structuredClone(conversation); fresh.transcriptCoverage.source = "host_adapter";
  fresh.messages.push({ id: "a-review", role: "assistant", sequence: 2, text: requirementReviewView(draft).text }, { id: "u-confirm", role: "user", sequence: 3, text: "确认" });
  fresh.taskBoundary.endMessageId = "u-confirm";
  const current = await sourceTask(dataDir, fresh);
  const confirmed = await applyRequirementReviewReply(dataDir, current.taskRef, { reviewRef: draft.reviewRef });
  return { draft, confirmed, current, fresh };
}

test("project profiles accept run configuration, reject business verdicts, traversal and overlapping storage", async () => temporary(async directory => {
  const { dataDir, profile } = await projectFixture(directory);
  assert.throws(() => ProjectProfileSchema.parse({ ...profile, verdict: "VERIFIED" }));
  for (const path of ["../escape", "C:/escape", "a\\b", "a/CON.txt", "a/space ", "/absolute"]) assert.throws(() => ProjectProfileSchema.parse({ ...profile, excludePaths: [path] }));
  assert.throws(() => assertProjectStorageSeparated(join(profile.projectRoot, "evidence"), profile), /overlap/);
  assert.throws(() => assertProjectStorageSeparated(directory, profile), /overlap/);
  assert.doesNotThrow(() => assertProjectStorageSeparated(dataDir, profile));
}));

test("project copies exclude declared dependencies and local secret filenames, record exclusions and remain frozen", async () => temporary(async directory => {
  const { dataDir, root, profile } = await projectFixture(directory);
  await mkdir(join(root, "node_modules")); await writeFile(join(root, "node_modules", "private.js"), "not copied");
  await writeFile(join(root, ".env"), "SYNTHETIC_TOKEN=not-a-real-key");
  await mkdir(join(root, "assets")); await writeFile(join(root, "assets", "message.txt"), "hello");
  const first = await captureProjectSnapshot(dataDir, profile);
  assert.equal(first.kind, "project-copy-not-executed");
  assert.deepEqual(first.excluded.map(item => item.path), [".env", "node_modules"]);
  assert.equal(first.entries.filter(item => item.kind === "file").length, 3);
  const second = await captureProjectSnapshot(dataDir, profile);
  assert.equal(second.snapshotHash, first.snapshotHash);
  await writeFile(join(root, "server.mjs"), "changed source");
  assert.equal((await readProjectSnapshot(dataDir, first.snapshotRef, profile)).snapshotHash, first.snapshotHash);
  assert.notEqual((await captureProjectSnapshot(dataDir, profile)).snapshotHash, first.snapshotHash);
  const copied = join(projectSnapshotDirectory(dataDir, first.snapshotRef), "files");
  assert.match(await readFile(join(copied, "server.mjs"), "utf8"), /must not execute/);
  assert.equal((await readdir(copied)).includes(".env"), false);
}));

test("snapshot readers reject altered bytes, extra files, profile substitution and links", async () => temporary(async directory => {
  const { dataDir, root, profile } = await projectFixture(directory);
  const snapshot = await captureProjectSnapshot(dataDir, profile), copied = join(projectSnapshotDirectory(dataDir, snapshot.snapshotRef), "files");
  await assert.rejects(readProjectSnapshot(dataDir, snapshot.snapshotRef, { ...profile, description: "substituted" }), /binding/);
  await writeFile(join(copied, "extra.mjs"), "extra");
  await assert.rejects(readProjectSnapshot(dataDir, snapshot.snapshotRef, profile), /unrecorded/);
  await rm(join(copied, "extra.mjs"));
  await writeFile(join(copied, "server.mjs"), "tampered");
  await assert.rejects(readProjectSnapshot(dataDir, snapshot.snapshotRef, profile), /contents changed/);
  await mkdir(join(directory, "outside"));
  await symlink(join(directory, "outside"), join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(captureProjectSnapshot(dataDir, profile), /symbolic links or junctions/);
}));

test("snapshot limits and missing project manifest fail without publishing complete evidence", async () => temporary(async directory => {
  const { dataDir, root, profile } = await projectFixture(directory);
  await assert.rejects(captureProjectSnapshot(dataDir, { ...profile, limits: { ...profile.limits, maxFileBytes: 2 } }), /byte limit/);
  await rm(join(root, "package.json"));
  await assert.rejects(captureProjectSnapshot(dataDir, profile), /requires package.json/);
  for (const ref of await readdir(join(dataDir, "project-snapshots"))) {
    assert.equal((await readdir(projectSnapshotDirectory(dataDir, ref))).includes("manifest.json"), false);
  }
}));

test("external registration requires genuine source confirmation and a matching capture; preparation is not acceptance", async () => temporary(async directory => {
  const { dataDir, profilePath } = await projectFixture(directory);
  const reviewed = await confirmedFixture(dataDir);
  await assert.rejects(prepareExternalProject(dataDir, profilePath, reviewed.draft.reviewRef, reviewed.current.taskRef), /superseded/);
  const later = structuredClone(reviewed.fresh);
  later.messages.push({ id: "u-later", role: "user", text: "增加其他目标。", sequence: 4 }); later.taskBoundary.endMessageId = "u-later";
  const laterTask = await sourceTask(dataDir, later);
  await assert.rejects(prepareExternalProject(dataDir, profilePath, reviewed.confirmed.reviewRef, laterTask.taskRef), /New user messages/);
  const prepared = await prepareExternalProject(dataDir, profilePath, reviewed.confirmed.reviewRef, reviewed.current.taskRef);
  assert.equal(prepared.task.execution.kind, "external_project");
  const inspected = await inspectExternalProject(dataDir, prepared.project.projectRef);
  assert.equal(inspected.status, "prepared_not_executed"); assert.equal(inspected.verdict, "UNVERIFIABLE");
  assert.equal(inspected.requirements[0]!.sourceRefs[0]!.quote, "增加文本转换功能。");
  let modelCalls = 0;
  const service = new VerificationService(dataDir, { async propose() { modelCalls++; throw new Error("must not call model"); } }, "fixture-no-model");
  const started = await service.request(prepared.task.taskRef), result = await service.wait(started.runId as string);
  assert.equal(result.verdict, "UNVERIFIABLE"); assert.equal(result.gapStage, "execution"); assert.equal(modelCalls, 0);
  assert.deepEqual((result.requirements as { evidenceIds: string[] }[])[0]!.evidenceIds, []);
  const output = await execute(process.execPath, ["dist/cli.js", "project-inspect", prepared.project.projectRef, "--data-dir", dataDir], { cwd: process.cwd() });
  assert.equal(JSON.parse(output.stdout).targetSnapshotHash, inspected.targetSnapshotHash);
}));

test("independent MCP protocol can read external preparation; tampered copies cannot be reused", async () => temporary(async directory => {
  const { dataDir, profilePath } = await projectFixture(directory), reviewed = await confirmedFixture(dataDir);
  const prepared = await prepareExternalProject(dataDir, profilePath, reviewed.confirmed.reviewRef, reviewed.current.taskRef);
  const service = new VerificationService(dataDir, { async propose() { throw new Error("no model"); } }, "fixture");
  const started = await service.request(prepared.task.taskRef); await service.wait(started.runId as string);
  const client = new Client({ name: "external-project-protocol-test", version: "0.0.1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/mcp-entry.js", "--data-dir", dataDir], env: {}, stderr: "pipe" }));
    const response = await client.callTool({ name: "get_verification", arguments: { runId: started.runId, includeReport: true } });
    assert.notEqual(response.isError, true);
    const payload = response.structuredContent as Record<string, any>;
    assert.equal(payload.verdict, "UNVERIFIABLE"); assert.equal(payload.externalProject.targetSnapshotHash, prepared.project.targetSnapshotHash);
  } finally { await client.close(); }
  await writeFile(join(projectSnapshotDirectory(dataDir, prepared.project.snapshotRef), "files", "server.mjs"), "altered");
  await assert.rejects(service.request(prepared.task.taskRef), /contents changed/);
}));

test("project snapshots refuse a redirected storage directory before copying", async () => temporary(async directory => {
  const { dataDir, profile } = await projectFixture(directory), outside = join(directory, "redirected-storage");
  await mkdir(outside);
  await symlink(outside, join(dataDir, "project-snapshots"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(captureProjectSnapshot(dataDir, profile), /symbolic links or junctions/);
  assert.deepEqual(await readdir(outside), []);
}));
