import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureTraeHook, exportTraeObservedConversation } from "../host-capture.js";
import { inspectConversation } from "../intake.js";

test("Trae hook observations preserve user and final assistant text without claiming a complete task", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vibeguard-trae-capture-"));
  try {
    const inputs = [
      { session_id: "session/one", hook_event_name: "SessionStart", source: "startup" },
      { session_id: "session/one", hook_event_name: "UserPromptSubmit", prompt: "满 150 元减 20 元。" },
      { session_id: "session/one", hook_event_name: "Stop", last_assistant_message: "已经完成。" },
      { session_id: "session/one", hook_event_name: "UserPromptSubmit", prompt: "改成满 120 元减 15 元。" },
      { session_id: "session/one", hook_event_name: "Stop", last_assistant_message: "已经修改。" },
    ];
    for (const input of inputs) await captureTraeHook(JSON.stringify(input), dataDir);
    const conversation = await exportTraeObservedConversation(dataDir, "session/one");
    assert.equal(conversation.transcriptCoverage.level, "partial");
    assert.match(inspectConversation(conversation).coverageIssues.join(" "), /partial/);
    assert.equal(conversation.host, "trae-hook-observation");
    assert.deepEqual(conversation.messages.map(item => [item.role, item.text]), [
      ["user", "满 150 元减 20 元。"],
      ["assistant", "已经完成。"],
      ["user", "改成满 120 元减 15 元。"],
      ["assistant", "已经修改。"],
    ]);
    assert.deepEqual(conversation.messages.map(item => item.sequence), [1, 2, 3, 4]);
    assert.equal(conversation.taskBoundary.startMessageId, conversation.messages[0]?.id);
    assert.equal(conversation.taskBoundary.endMessageId, conversation.messages[3]?.id);
    const sessionKey = (await readdir(join(dataDir, "host-events", "trae")))[0]!;
    assert.match(sessionKey, /^[a-f0-9]{64}$/);
    const eventFiles = await readdir(join(dataDir, "host-events", "trae", sessionKey));
    assert.equal(eventFiles.length, 5);
    const rawEvent = await readFile(join(dataDir, "host-events", "trae", sessionKey, eventFiles[1]!), "utf8");
    assert.equal(rawEvent.includes("session/one"), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("malformed Trae hook payload is rejected before writing a captured event", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vibeguard-trae-invalid-"));
  try {
    await assert.rejects(captureTraeHook(JSON.stringify({ session_id: "s", hook_event_name: "UserPromptSubmit" }), dataDir));
    await assert.rejects(captureTraeHook(JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse" }), dataDir));
    await assert.rejects(exportTraeObservedConversation(dataDir, "s"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
