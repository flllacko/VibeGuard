import assert from "node:assert/strict";
import { test } from "node:test";
import { readCodexHistory, type CodexHistoryReader, CodexReadClient } from "../codex-history.js";

const threadId = "00000000-0000-4000-8000-000000000001";
const turn1 = { id: "t1", itemsView: "full", status: "completed", items: [{ id: "u1", type: "userMessage", content: [{ type: "text", text: "先不写代码，整理方案。" }] }, { id: "a1", type: "agentMessage", text: "方案已经整理。" }] };
const turn2 = { id: "t2", itemsView: "full", status: "interrupted", items: [{ id: "u2", type: "userMessage", content: [{ type: "text", text: "开始吧，使用 TypeScript。" }] }, { id: "a2", type: "agentMessage", text: "采集发生后才产生的输出" }] };

function reader(pages: unknown[], initialTurns: unknown[] = [turn1, turn2]): CodexHistoryReader {
  let index = 0;
  return { async readThread() { return { thread: { id: threadId, turns: initialTurns } }; }, async listTurns() { return pages[index++]; } };
}

test("Codex capture reads all full pages, preserves original changes and bounds the snapshot at its latest user message", async () => {
  const captured = await readCodexHistory(reader([{ data: [turn1], nextCursor: "p2" }, { data: [turn2], nextCursor: null }]), threadId);
  assert.equal(captured.receipt.allPagesRead, true);
  assert.equal(captured.receipt.pageCount, 2);
  assert.equal(captured.receipt.userMessageCount, 2);
  assert.deepEqual(captured.conversation.messages.map(item => item.text), ["先不写代码，整理方案。", "方案已经整理。", "开始吧，使用 TypeScript。"]);
  assert.equal(captured.conversation.taskBoundary.endMessageId, "u2");
  assert.equal(captured.conversation.transcriptCoverage.level, "partial");
  assert.equal(captured.receipt.taskScopeConfirmed, false);
});

test("Codex capture refuses summary-only pages and history missing a known original message", async () => {
  await assert.rejects(readCodexHistory(reader([{ data: [{ ...turn1, itemsView: "summary" }], nextCursor: null }]), threadId));
  await assert.rejects(readCodexHistory(reader([{ data: [turn1], nextCursor: null }]), threadId), /known Codex turn is missing/);
  await assert.rejects(readCodexHistory(reader([{ data: [turn1, { ...turn2, items: [] }], nextCursor: null }]), threadId), /Latest known user message is missing/);
});

test("Codex capture rejects changed user text and repeating pagination", async () => {
  await assert.rejects(readCodexHistory(reader([{ data: [turn1, { ...turn2, items: [{ id: "u2", type: "userMessage", content: [{ type: "text", text: "改过的原话" }] }] }], nextCursor: null }]), threadId), /Original user text changed/);
  await assert.rejects(readCodexHistory(reader([{ data: [turn1], nextCursor: "p2" }, { data: [turn1], nextCursor: "p2" }]), threadId), /repeated a turn/);
});

test("a missing Codex binary fails promptly and the client can close", async () => {
  const client = new CodexReadClient("vibeguard-nonexistent-codex-executable");
  try { await assert.rejects(client.initialize()); } finally { await client.close(); }
});
