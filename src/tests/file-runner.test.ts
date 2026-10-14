import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { FileCheckSchema, FileProfileSchema, assertEvidenceOutsideRoots, assertFilePlanMatchesProfile, fileProfileHash, type FileCheck, type FileProfile } from "../file-profile.js";
import { captureFileSnapshot } from "../file-snapshot.js";
import { runFilePlan } from "../file-runner.js";
import { freezePlan } from "../planning.js";
import { readConversation } from "../intake.js";
import type { Resolution } from "../requirements.js";
import { saveResolution } from "../resolution-storage.js";
import { savePlanRecord } from "../plan-storage.js";
import { registerTask } from "../task-registry.js";

const quote = "完整保留目录结构和内容。";
const compare: FileCheck = { checkId: "all-files", type: "tree_compare", purpose: "完整对照", reference: { rootId: "source", path: "" }, target: { rootId: "delivery", path: "" }, comparison: "content" };
function resolution(hash = "test-conversation"): Resolution {
  return { schemaVersion: 1, resolutionId: randomUUID(), taskId: "file-test", createdAt: new Date().toISOString(), conversationSha256: hash,
    transcriptCoverage: { level: "complete", source: "user_export", basis: "完整测试材料", missingMessageIds: [] }, coverageIssues: [],
    revisions: [{ requirementId: "preserve", revision: 1, status: "active", normalized: quote, sourceKind: "explicit_user", sourceRefs: [{ messageId: "u1", start: 0, end: quote.length, quote }] }],
    dispositions: [], processing: [], unprocessedUserMessageIds: [], resolutionComplete: true };
}
function planFor(input: Resolution, check: FileCheck = compare) {
  return freezePlan(input, { criteria: [{ criterionId: "preservation", requirementIds: ["preserve"], sourceKind: "explicit_user", description: quote, preconditions: [], expected: "源与交付一致", checks: [check] }], coverage: [{ requirementId: "preserve", criterionIds: ["preservation"], status: "planned" }] }, "manual-fixture");
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-files-"));
  const source = join(directory, "source");
  const delivery = join(directory, "delivery");
  for (const root of [source, delivery]) {
    await mkdir(join(root, "empty"), { recursive: true });
    await writeFile(join(root, "SKILL.md"), "abcd");
  }
  const profile = FileProfileSchema.parse({ schemaVersion: 1, profileId: "file-test", description: "测试目录", roots: [
    { rootId: "source", role: "reference", description: "原始文件", path: source },
    { rootId: "delivery", role: "delivery", description: "交付文件", path: delivery },
  ] });
  return { directory, source, delivery, profile };
}
async function cleanup(directory: string) {
  const absolute = resolve(directory);
  if (dirname(absolute) !== resolve(tmpdir()) || !absolute.startsWith(join(resolve(tmpdir()), "vibeguard-files-"))) throw new Error("Refusing cleanup outside test workspace");
  await rm(absolute, { recursive: true, force: true });
}
async function run(profile: FileProfile, check: FileCheck = compare) {
  const input = resolution();
  return runFilePlan(planFor(input, check), input, profile);
}

test("file evidence detects same-size content changes, empty directory removal and extra files", async () => {
  const f = await fixture();
  try {
    const correct = await run(f.profile);
    assert.equal(correct.report.verdict, "VERIFIED");
    assert.equal(correct.report.requirements[0]!.sourceRefs[0]!.quote, quote);
    assert.deepEqual(correct.evidence.at(-1)!.observed!.target, { files: 1, directories: 1 });
    await writeFile(join(f.delivery, "SKILL.md"), "abce");
    const changed = await run(f.profile);
    assert.equal(changed.report.verdict, "FAILED");
    assert.deepEqual(changed.evidence.at(-1)!.observed!.changed, ["SKILL.md"]);
    assert.equal((await run(f.profile, { ...compare, comparison: "structure" })).report.verdict, "VERIFIED");
    await rmdir(join(f.delivery, "empty"));
    await writeFile(join(f.delivery, "extra.txt"), "x");
    const incomplete = await run(f.profile);
    assert.deepEqual(incomplete.evidence.at(-1)!.observed!.missing, ["empty"]);
    assert.deepEqual(incomplete.evidence.at(-1)!.observed!.extra, ["extra.txt"]);
    assert.equal(incomplete.report.verdict, "FAILED");
  } finally { await cleanup(f.directory); }
});

test("missing delivery fails while missing reference cannot prove preservation", async () => {
  const f = await fixture();
  try {
    const missingDelivery = structuredClone(f.profile);
    missingDelivery.roots.find(root => root.rootId === "delivery")!.path = join(f.directory, "absent-delivery");
    assert.equal((await run(missingDelivery)).report.verdict, "FAILED");
    const missingSource = structuredClone(f.profile);
    missingSource.roots.find(root => root.rootId === "source")!.path = join(f.directory, "absent-source");
    assert.equal((await run(missingSource)).report.verdict, "UNVERIFIABLE");
    const exists: FileCheck = { checkId: "root-skill", type: "entry_exists", purpose: "入口在第一层", target: { rootId: "delivery", path: "SKILL.md" }, expectedKind: "file" };
    assert.equal((await run(f.profile, exists)).report.verdict, "VERIFIED");
    await mkdir(join(f.delivery, "wrong-type"));
    assert.equal((await run(f.profile, { ...exists, target: { rootId: "delivery", path: "wrong-type" } })).report.verdict, "FAILED");
  } finally { await cleanup(f.directory); }
});

test("junctions and size or entry limits never turn partial inventories into verified evidence", async () => {
  const f = await fixture();
  try {
    for (const limits of [{ maxFileBytes: 2 }, { maxEntries: 1 }, { maxTotalBytes: 2 }]) {
      const bounded = FileProfileSchema.parse({ ...f.profile, limits: { ...f.profile.limits, ...limits } });
      const result = await run(bounded);
      assert.equal(result.report.verdict, "UNVERIFIABLE");
      assert.equal(result.evidence[0]!.snapshot!.roots.some(root => root.status === "unavailable" && root.entries.length === 0), true);
    }
    await symlink(f.source, join(f.delivery, "link"), process.platform === "win32" ? "junction" : "dir");
    const linked = await run(f.profile);
    assert.equal(linked.report.verdict, "UNVERIFIABLE");
    const root = linked.evidence[0]!.snapshot!.roots.find(item => item.rootId === "delivery")!;
    assert.equal(root.entries.length, 0);
    assert.match(root.error!, /link|junction/i);
    assert.equal(await readFile(join(f.source, "SKILL.md"), "utf8"), "abcd");
  } finally { await cleanup(f.directory); }
});

test("a delivery changed between snapshots is unverified instead of judged against a stale snapshot", async () => {
  const f = await fixture();
  try {
    const input = resolution();
    const before = await captureFileSnapshot(f.profile);
    await writeFile(join(f.delivery, "SKILL.md"), "abce");
    const result = await runFilePlan(planFor(input), input, f.profile, before);
    assert.equal(result.report.verdict, "UNVERIFIABLE");
    assert.match(result.report.requirements[0]!.reason, /状态发生变化/);
    assert.notEqual(result.evidence[0]!.snapshot!.snapshotHash, result.evidence[1]!.snapshot!.snapshotHash);
  } finally { await cleanup(f.directory); }
});

test("file plans reject traversal, unauthorized roots, self-comparison, commands and agent verdicts", async () => {
  const f = await fixture();
  try {
    const input = resolution();
    for (const path of ["../SKILL.md", "/SKILL.md", "C:/secret", "a\\b", "a/", "a//b"]) assert.throws(() => FileCheckSchema.parse({ ...compare, target: { rootId: "delivery", path } }));
    for (const target of ["source", "unknown"]) assert.throws(() => assertFilePlanMatchesProfile(planFor(input, { ...compare, target: { rootId: target, path: "" } }), f.profile));
    const self = structuredClone(f.profile);
    self.roots.find(root => root.rootId === "delivery")!.path = f.source;
    assert.throws(() => assertFilePlanMatchesProfile(planFor(input), self), /itself/);
    assert.throws(() => FileCheckSchema.parse({ ...compare, command: "node unsafe.js" }));
    assert.throws(() => FileCheckSchema.parse({ ...compare, verdict: "VERIFIED" }));
    assert.throws(() => assertEvidenceOutsideRoots(join(f.delivery, ".vibeguard"), f.profile));
  } finally { await cleanup(f.directory); }
});

function payload(result: CallToolResult): Record<string, any> {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return result.structuredContent as Record<string, any>;
}
async function connect(dataDir: string) {
  const client = new Client({ name: "file-verification-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../mcp-entry.js", import.meta.url)), "--data-dir", dataDir], stderr: "pipe" }));
  return client;
}
async function completed(client: Client, runId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = payload(await client.callTool({ name: "get_verification", arguments: { runId, includeReport: true } }));
    if (state.status === "completed") return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("File verification did not complete");
}

test("MCP file execution persists evidence across restart and changed delivery invalidates cached verdict", async () => {
  const f = await fixture();
  let client: Client | undefined;
  try {
    const dataDir = join(f.directory, "evidence");
    const taskPath = join(f.directory, "task.json");
    await writeFile(taskPath, JSON.stringify({ schemaVersion: 1, taskId: "file-test", sessionId: "fixture", host: "fixture", taskBoundary: { startMessageId: "u1", endMessageId: "a1" }, transcriptCoverage: { level: "complete", source: "user_export", basis: "complete fixture", missingMessageIds: [] }, messages: [{ id: "u1", sequence: 1, role: "user", text: quote }, { id: "a1", sequence: 2, role: "assistant", text: "完成了" }] }));
    const input = resolution((await readConversation(taskPath)).rawSha256);
    const plan = planFor(input);
    await saveResolution(input, dataDir);
    await savePlanRecord(dataDir, { plan, generation: { model: "manual-test", promptHash: "manual", usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, profileId: f.profile.profileId, profileSha256: fileProfileHash(f.profile) } });
    const profilePath = join(f.directory, "profile.json");
    await writeFile(profilePath, JSON.stringify(f.profile));
    const task = await registerTask(dataDir, taskPath, "final", undefined, { planHash: plan.planHash, profilePath });
    client = await connect(dataDir);
    const request = payload(await client.callTool({ name: "verify_task", arguments: { taskRef: task.taskRef } }));
    const passed = await completed(client, request.runId);
    assert.equal(passed.verdict, "VERIFIED");
    assert.equal(passed.kind, "planned-file-run");
    const evidenceId = passed.requirements[0].evidenceIds.at(-1);
    const firstEvidence = payload(await client.callTool({ name: "read_evidence", arguments: { runId: request.runId, evidenceId, limit: 8000 } }));
    assert.equal(JSON.parse(firstEvidence.text).collector, "vibeguard-file");
    assert.equal(payload(await client.callTool({ name: "verify_task", arguments: { taskRef: task.taskRef } })).reused, true);
    await client.close();
    client = await connect(dataDir);
    assert.equal((await completed(client, request.runId)).verdict, "VERIFIED");
    const restored = payload(await client.callTool({ name: "read_evidence", arguments: { runId: request.runId, evidenceId, limit: 8000 } }));
    assert.equal(restored.sha256, firstEvidence.sha256);
    await writeFile(join(f.delivery, "SKILL.md"), "abce");
    const second = payload(await client.callTool({ name: "verify_task", arguments: { taskRef: task.taskRef } }));
    assert.notEqual(second.runId, request.runId);
    assert.equal(second.reused, false);
    assert.equal((await completed(client, second.runId)).verdict, "FAILED");
    await writeFile(join(dataDir, "planned-runs", passed.reportRef, `${evidenceId}.json`), "{}");
    assert.equal((await client.callTool({ name: "read_evidence", arguments: { runId: request.runId, evidenceId } })).isError, true);
  } finally { await client?.close(); await cleanup(f.directory); }
});
