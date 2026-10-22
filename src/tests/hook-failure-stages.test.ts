import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { prepareVerificationHook, verificationToolName } from "../capture-hook.js";

test("Hook distinguishes invalid input, failed capture and post-capture binding without exposing private errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-hook-stages-"));
  try {
    let calls = 0;
    const options = { host: "codex" as const, dataDir: join(directory, "data") };
    const collect = async () => { calls++; return { taskRef: randomUUID() }; };
    const invalid = await prepareVerificationHook('{"private":"PRIVATE_INPUT"}', options, collect);
    assert.equal(calls, 0);
    assert.match(invalid.hookSpecificOutput!.permissionDecisionReason!, /\[VG_INPUT\]/);
    assert.equal(JSON.stringify(invalid).includes("PRIVATE_INPUT"), false);
    const payload = { hook_event_name: "PreToolUse", tool_name: verificationToolName, session_id: randomUUID(), cwd: directory,
      tool_use_id: "host-probe", tool_input: { externalPlanRef: randomUUID() } };
    const noIdentity = await prepareVerificationHook(JSON.stringify({ ...payload, tool_use_id: undefined }), options, collect);
    assert.match(noIdentity.hookSpecificOutput!.permissionDecisionReason!, /\[VG_INPUT\]/);
    assert.equal(calls, 0);
    const missingPlan = await prepareVerificationHook(JSON.stringify(payload), options, collect);
    assert.equal(calls, 1);
    assert.equal(missingPlan.hookSpecificOutput!.permissionDecision, "deny");
    assert.match(missingPlan.hookSpecificOutput!.permissionDecisionReason!, /\[VG_BINDING\].*已取得当前会话快照/);
    assert.equal(JSON.stringify(missingPlan).includes(directory), false);
    const invalidCapture = await prepareVerificationHook(JSON.stringify(payload), options, async () => ({ taskRef: "PRIVATE_INVALID_REF" }));
    assert.match(invalidCapture.hookSpecificOutput!.permissionDecisionReason!, /\[VG_CAPTURE\]/);
    assert.equal(JSON.stringify(invalidCapture).includes("PRIVATE_INVALID_REF"), false);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
});
