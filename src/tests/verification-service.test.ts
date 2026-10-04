import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerTask } from "../task-registry.js";
import { VerificationService } from "../verification-service.js";
import type { RequirementGateway } from "../requirements.js";
import { fixtureUnitCoverage } from "./fixture-unit-coverage.js";

test("shared verification service separates running/unknown/completed and never turns requirement extraction into execution proof", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vibeguard-verification-"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const gateway: RequirementGateway = {
    async propose(input) {
      calls++;
      await gate;
      return { model: "fixture", proposal: fixtureUnitCoverage(input, { dispositions: [{ messageId: "u1", kind: "requirements", reason: "用户要求" }], events: [{ action: "add", requirementId: "login", normalized: "增加登录功能", source: { messageId: "u1", quote: "增加登录功能" } }] }) };
    },
  };
  try {
    const source = join(dataDir, "conversation.json");
    await writeFile(source, JSON.stringify({ schemaVersion: 1, taskId: "login", sessionId: "test", host: "fixture", taskBoundary: { startMessageId: "u1", endMessageId: "u1" }, transcriptCoverage: { level: "complete", source: "user_export", basis: "complete fixture", missingMessageIds: [] }, messages: [{ id: "u1", sequence: 1, role: "user", text: "增加登录功能" }] }));
    const task = await registerTask(dataDir, source);
    const owner = new VerificationService(dataDir, gateway, "fixture");
    const observer = new VerificationService(dataDir, gateway, "fixture");
    const started = await owner.request(task.taskRef);
    const runId = started.runId as string;
    assert.equal(started.status, "running");
    const concurrent = await observer.request(task.taskRef);
    assert.equal(concurrent.runId, runId);
    assert.equal(concurrent.status, "indeterminate");
    assert.equal(concurrent.verdict, "UNVERIFIABLE");
    release();
    const completed = await owner.wait(runId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.verdict, "UNVERIFIABLE");
    assert.equal(completed.gapStage, "execution");
    assert.deepEqual((completed.requirements as any[])[0].sourceRefs.map((item: { quote: string }) => item.quote), ["增加登录功能"]);
    assert.equal((completed.interpretationCoverage as { classifiedUnits: number }).classifiedUnits, 1);
    assert.equal(completed.interpretedUnits, undefined);
    const detailed = await owner.get(runId, true);
    assert.equal((detailed.interpretedUnits as any[])[0].quote, "增加登录功能");
    assert.deepEqual((completed.requirements as any[])[0].evidenceIds, []);
    const reread = await observer.get(runId);
    assert.equal(reread.status, "completed");
    await observer.request(task.taskRef);
    assert.equal(calls, 1);
    const updatedPolicy = new VerificationService(dataDir, { ...gateway, policyId: "changed-requirement-policy" }, "fixture");
    const updated = await updatedPolicy.request(task.taskRef);
    assert.notEqual(updated.runId, runId);
    await updatedPolicy.wait(updated.runId as string);
    assert.equal(calls, 2);
  } finally {
    release();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("changed registered conversation is a material gap and does not call the model", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vibeguard-verification-material-"));
  let calls = 0;
  const gateway: RequirementGateway = { async propose() { calls++; throw new Error("Model must not run for changed material"); } };
  try {
    const source = join(dataDir, "conversation.json");
    const conversation = { schemaVersion: 1, taskId: "login", sessionId: "test", host: "fixture", taskBoundary: { startMessageId: "u1", endMessageId: "u1" }, transcriptCoverage: { level: "complete", source: "user_export", basis: "complete fixture", missingMessageIds: [] }, messages: [{ id: "u1", sequence: 1, role: "user", text: "增加登录功能" }] };
    await writeFile(source, JSON.stringify(conversation));
    const task = await registerTask(dataDir, source);
    conversation.messages = [{ id: "u1", sequence: 1, role: "user", text: "增加支付功能" }];
    await writeFile(join(dataDir, "conversations", `${task.conversationSha256}.json`), JSON.stringify(conversation));
    const service = new VerificationService(dataDir, gateway, "fixture");
    const started = await service.request(task.taskRef);
    const completed = await service.wait(started.runId as string);
    assert.equal(completed.status, "completed");
    assert.equal(completed.verdict, "UNVERIFIABLE");
    assert.equal(completed.gapStage, "material");
    assert.match((completed.issues as string[]).join(" "), /hash mismatch/);
    assert.equal(calls, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
