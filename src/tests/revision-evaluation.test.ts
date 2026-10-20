import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { prepareRevisionEvaluation } from "../evaluate-revision-run.js";

test("revision evaluation prepares exact minimal outbound inputs without sending scripts or independent answers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-revision-evaluation-"));
  try {
    const file = resolve("fixtures/evaluations/d3-revision-reverification.json");
    const sample = JSON.parse(await readFile(file, "utf8"));
    sample.initial.script = "// PRIVATE_INITIAL_SCRIPT"; sample.updatedScript = "// PRIVATE_REPAIRED_SCRIPT";
    sample.initial.oracle[0].equals = "PRIVATE_INITIAL_ORACLE"; sample.revision.oracle[0].equals = "PRIVATE_REVISED_ORACLE";
    sample.revision.expectedNormalized.includes = ["PRIVATE_SEMANTIC_ORACLE"];
    const path = join(directory, "case.json"); await writeFile(path, JSON.stringify(sample));
    const out = join(directory, "out"), prepared = await prepareRevisionEvaluation(path, out);
    assert.equal(prepared.modelCalls, 0);
    const outbound = await readFile(join(out, "outgoing-review.md"), "utf8");
    for (const forbidden of ["PRIVATE_INITIAL_SCRIPT", "PRIVATE_REPAIRED_SCRIPT", "PRIVATE_INITIAL_ORACLE", "PRIVATE_REVISED_ORACLE", "PRIVATE_SEMANTIC_ORACLE"]) assert.equal(outbound.includes(forbidden), false);
    assert.ok(outbound.includes(sample.initial.requirement)); assert.ok(outbound.includes(sample.revision.reply));
    assert.match(outbound, /最多六次响应/);
    await assert.rejects(prepareRevisionEvaluation(path, out), { code: "EEXIST" });
  } finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
});
