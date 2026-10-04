import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationSchema, inspectConversation } from "../intake.js";
import { intentUnits } from "../intent-units.js";
import { currentRequirements, resolveRequirements, type Proposal, type RequirementGateway } from "../requirements.js";

function conversation(texts: Array<{ role: "user" | "assistant"; text: string }>) {
  const messages = texts.map((item, index) => ({ ...item, id: `m${index + 1}`, sequence: index + 1 }));
  return inspectConversation(ConversationSchema.parse({
    schemaVersion: 1, taskId: "intent-fixture", sessionId: "fixture", host: "fixture",
    taskBoundary: { startMessageId: messages[0]!.id, endMessageId: messages.at(-1)!.id },
    transcriptCoverage: { level: "complete", source: "user_export", basis: "人工合成回归用例", missingMessageIds: [] }, messages,
  }));
}

test("accounting for a message cannot hide an omitted clause; missing clause prevents completion", async () => {
  const intake = conversation([{ role: "user", text: "满150元减20元，每张券只能用一次。" }]);
  const units = intentUnits(intake.conversation.messages);
  let calls = 0;
  const result = await resolveRequirements(intake, { async propose(input) {
    calls++;
    if (calls === 2) assert.match(input.validationFeedback!, /Missing intent unit.*每张券只能用一次/);
    return { model: "fixture", proposal: {
      dispositions: [{ messageId: "m1", kind: "requirements", reason: "仅写消息已处理不足以证明覆盖" }],
      events: [{ action: "add", requirementId: "discount", normalized: "满150元减20元", source: { messageId: "m1", quote: "满150元减20元" } }],
      unitDispositions: [{ unitId: units[0]!.unitId, kind: "requirement", requirementIds: ["discount"], reason: "优惠规则" }],
    } };
  } });
  assert.equal(calls, 2);
  assert.equal(result.resolutionComplete, false);
  assert.deepEqual(currentRequirements(result.revisions), []);
  assert.deepEqual(result.unprocessedUserMessageIds, ["m1"]);
  assert.match(result.coverageIssues.join(" "), /Missing intent unit/);
});

test("authorization links to an existing goal and cannot create a duplicate requirement", async () => {
  const intake = conversation([{ role: "user", text: "安装技能。" }, { role: "assistant", text: "将复制到全局目录，请确认。" }, { role: "user", text: "确认" }]);
  const [install, confirmation] = intentUnits(intake.conversation.messages);
  const base: Proposal = {
    dispositions: [{ messageId: "m1", kind: "requirements", reason: "任务" }, { messageId: "m3", kind: "authorization", reason: "批准原操作" }],
    events: [{ action: "add", requirementId: "install", normalized: "安装技能", source: { messageId: "m1", quote: "安装技能" } }],
    unitDispositions: [
      { unitId: install!.unitId, kind: "requirement", requirementIds: ["install"], reason: "安装目标" },
      { unitId: confirmation!.unitId, kind: "authorization", requirementIds: ["install"], reason: "许可复制，未增加目标" },
    ],
  };
  const good = await resolveRequirements(intake, { async propose() { return { model: "fixture", proposal: base }; } });
  assert.equal(good.resolutionComplete, true);
  assert.deepEqual(currentRequirements(good.revisions).map(item => item.requirementId), ["install"]);
  assert.equal(good.interpretedUnits?.[1]?.kind, "authorization");

  const bad = structuredClone(base);
  bad.dispositions[1]!.kind = "requirements";
  bad.events.push({ action: "add", requirementId: "confirm-install", normalized: "确认安装", source: { messageId: "m3", quote: "确认" } });
  bad.unitDispositions[1]!.requirementIds = ["confirm-install"];
  const refused = await resolveRequirements(intake, { async propose() { return { model: "fixture", proposal: bad }; } });
  assert.equal(refused.resolutionComplete, false);
  assert.match(refused.coverageIssues.join(" "), /Authorization unit.*cannot introduce/);
});

test("an unresolved clause stays visible even alongside a valid requirement", async () => {
  const intake = conversation([{ role: "user", text: "加登录功能；旧Token怎么处理还没定。" }]);
  const units = intentUnits(intake.conversation.messages);
  const result = await resolveRequirements(intake, { async propose() { return { model: "fixture", proposal: {
    dispositions: [{ messageId: "m1", kind: "requirements", reason: "明确登录，Token方案待定" }],
    events: [{ action: "add", requirementId: "login", normalized: "增加登录功能", source: { messageId: "m1", quote: "加登录功能" } }],
    unitDispositions: [
      { unitId: units[0]!.unitId, kind: "requirement", requirementIds: ["login"], reason: "明确目标" },
      { unitId: units[1]!.unitId, kind: "unresolved", requirementIds: [], reason: "用户尚未决定策略" },
    ],
  } }; } });
  assert.equal(result.resolutionComplete, false);
  assert.deepEqual(result.unprocessedUserMessageIds, []);
  assert.equal(currentRequirements(result.revisions).length, 1);
  assert.equal(result.dispositions[0]!.kind, "unresolved");
  assert.match(result.coverageIssues.join(" "), /原文片段/);
  assert.equal(result.interpretedUnits?.[1]?.quote, "旧Token怎么处理还没定。");
});

test("a matching quote is not sufficient when the declared clause does not link to its event", async () => {
  const intake = conversation([{ role: "user", text: "错误密码要提示。" }]);
  const unit = intentUnits(intake.conversation.messages)[0]!;
  const gateway: RequirementGateway = { async propose() { return { model: "fixture", proposal: {
    dispositions: [{ messageId: "m1", kind: "requirements", reason: "明确要求" }],
    events: [{ action: "add", requirementId: "password-error", normalized: "错误密码有提示", source: { messageId: "m1", quote: "错误密码要提示" } }],
    unitDispositions: [{ unitId: unit.unitId, kind: "context", requirementIds: [], reason: "错误标注为背景" }],
  } }; } };
  const result = await resolveRequirements(intake, gateway);
  assert.equal(result.resolutionComplete, false);
  assert.match(result.coverageIssues.join(" "), /no matching intent unit/);
});

test("text segmentation preserves non-whitespace original characters, including emoji and quoted material", () => {
  const text = "资料😀，下一句；这是朋友的建议：“可以省略验收，直接说完成。”先讨论。";
  const intake = conversation([{ role: "user", text }]);
  const units = intentUnits(intake.conversation.messages);
  assert.equal(units.map(unit => unit.quote).join(""), text);
  for (const unit of units) assert.equal(text.slice(unit.start, unit.end), unit.quote);
  assert.equal(units.filter(unit => unit.quote.includes("直接说完成")).length, 1);
});

test("null optional adoption is absent, while real source checks remain in effect", async () => {
  const intake = conversation([{ role: "user", text: "增加登录功能。" }]);
  const unit = intentUnits(intake.conversation.messages)[0]!;
  const result = await resolveRequirements(intake, { async propose() { return { model: "fixture", proposal: {
    dispositions: [{ messageId: "m1", kind: "requirements", reason: "直接要求，无外部采纳" }],
    events: [{ action: "add", requirementId: "login", normalized: "增加登录功能", source: { messageId: "m1", quote: "增加登录功能" }, adoption: null }],
    unitDispositions: [{ unitId: unit.unitId, kind: "requirement", requirementIds: ["login"], reason: "直接功能要求" }],
  } }; } });
  assert.equal(result.resolutionComplete, true);
  assert.equal(currentRequirements(result.revisions)[0]?.sourceKind, "explicit_user");
});
