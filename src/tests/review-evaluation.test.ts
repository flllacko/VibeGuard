import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { prepareReviewEvaluation, runReviewEvaluation } from "../evaluate-review-replies.js";

test("offline evaluation preparation separates the oracle from outgoing model data and refuses changed cases before a paid call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-review-eval-"));
  try {
    const path = join(directory, "cases.json"), out = join(directory, "prepared");
    await writeFile(path, JSON.stringify([{ id: "offline-only", requirements: [{ text: "导出数据保留原行顺序。" }], answer: "顺序还是原来的，不要排序。",
      expected: { status: "awaiting_review", actions: [], unchanged: ["R1"], activeCount: 1, semanticChecks: [], notes: "ORACLE_SENTINEL_NOT_FOR_MODEL" } }]));
    const prepared = await prepareReviewEvaluation(path, out);
    assert.equal(prepared.modelCalls, 0);
    const outgoing = await readFile(join(out, "outgoing-inputs.json"), "utf8");
    assert.doesNotMatch(outgoing, /ORACLE_SENTINEL_NOT_FOR_MODEL|"expected"/);
    const manifest = JSON.parse(await readFile(prepared.manifest, "utf8"));
    assert.equal(manifest.cases[0].case.expected.notes, "ORACLE_SENTINEL_NOT_FOR_MODEL");
    await writeFile(join(out, "case-set.json"), "[]");
    await assert.rejects(runReviewEvaluation(prepared.manifest), /参考答案发生改变/);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
});
