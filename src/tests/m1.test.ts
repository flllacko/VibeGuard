import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskSchema } from "../contracts.js";
import { EvidenceStore } from "../storage.js";
import { verifyDemo } from "../verification.js";

test("real HTTP and stored-order evidence distinguish correct, faulty, unavailable", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vibeguard-m1-"));
  try {
    const store = await EvidenceStore.open(dataDir);
    const correct = await verifyDemo("correct", store);
    const faulty = await verifyDemo("faulty", store);
    const unavailable = await verifyDemo("unavailable", store);
    assert.equal(correct.verdict, "VERIFIED");
    assert.equal(correct.taskVerdict, "UNVERIFIABLE");
    assert.deepEqual(correct.checks.map(check => check.verdict), ["VERIFIED", "VERIFIED"]);
    assert.equal(faulty.verdict, "FAILED");
    assert.equal(faulty.taskVerdict, "FAILED");
    assert.deepEqual(faulty.checks.map(check => check.verdict), ["VERIFIED", "FAILED"]);
    assert.equal(unavailable.verdict, "UNVERIFIABLE");
    assert.deepEqual(unavailable.checks.map(check => check.verdict), ["UNVERIFIABLE", "UNVERIFIABLE"]);
    const task = TaskSchema.parse(JSON.parse(await readFile(new URL("../../fixtures/conversations/coupon-demo.json", import.meta.url), "utf8")));
    for (const ref of faulty.sourceRefs) {
      const message = task.messages.find(item => item.id === ref.messageId);
      assert.equal(message?.text.slice(ref.start, ref.end), ref.quote);
    }
    store.close();

    const reopened = await EvidenceStore.open(dataDir);
    const reloaded = reopened.getReport(faulty.runId);
    assert.equal(reloaded?.checks[1]?.verdict, "FAILED");
    const evidenceId = faulty.checks[1]!.evidenceId;
    const evidence = await reopened.getEvidence(evidenceId);
    assert.equal(evidence?.record.response?.status, 201);
    assert.equal((evidence?.record.storedOrder?.body as { discountCents?: number }).discountCents, 2000);
    reopened.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
