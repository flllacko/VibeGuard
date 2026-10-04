import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ConversationSchema, inspectConversation } from "../intake.js";
import { parseModelJson, requirementModelPayload } from "../pi-gateway.js";
import { attributedExternalRanges } from "../provenance.js";
import { currentRequirements, resolveRequirements as resolveCore, type GatewayInput, type GatewayOutput, type RequirementGateway, type Proposal } from "../requirements.js";
import type { IntakeResult } from "../intake.js";
import { fixtureUnitCoverage } from "./fixture-unit-coverage.js";

// Preserve the original fixture scenarios while supplying the new structural
// contract. Intent-coverage failure tests call resolveRequirements directly.
interface LegacyFixtureGateway { propose(input: GatewayInput): Promise<Omit<GatewayOutput, "proposal"> & { proposal: Omit<Proposal, "unitDispositions"> }> }
function resolveRequirements(intake: IntakeResult, gateway: LegacyFixtureGateway, budget?: number) {
  return resolveCore(intake, { async propose(input) {
    const output = await gateway.propose(input);
    return { ...output, proposal: fixtureUnitCoverage(input, output.proposal) };
  } }, budget);
}

const fixtureUrl = new URL("../../fixtures/conversations/coupon-complete.json", import.meta.url);

async function fixture() {
  return inspectConversation(ConversationSchema.parse(JSON.parse(await readFile(fixtureUrl, "utf8"))));
}

test("model sees full conversation but only user messages have referencable IDs", async () => {
  const intake = await fixture();
  const payload = requirementModelPayload({ taskId: intake.conversation.taskId, messages: intake.conversation.messages, knownRequirements: [] }) as {
    allowedUserMessageIds: string[];
    messages: Array<{ id?: string; role: string; text: string }>;
  };
  assert.deepEqual(payload.allowedUserMessageIds, ["u1", "u2", "u3"]);
  assert.equal(payload.messages.length, 5);
  assert.equal(payload.messages.find(item => item.text === "已经完成，测试通过。")?.id, undefined);
});

test("a trailing comma outside quoted text is repaired without changing quoted content", () => {
  assert.deepEqual(parseModelJson('{"quote":"literal ,} remains", "items":[1,2,],}'), { quote: "literal ,} remains", items: [1, 2] });
  assert.throws(() => parseModelJson('{"quote":123, broken}'));
});

class FixtureGateway implements LegacyFixtureGateway {
  async propose(input: GatewayInput): Promise<Omit<GatewayOutput, "proposal"> & { proposal: Omit<Proposal, "unitDispositions"> }> {
    if (input.messages.some(message => message.id === "u1")) {
      return { model: "fixture-not-a-real-model", proposal: {
        dispositions: [{ messageId: "u1", kind: "requirements", reason: "提出三项规则" }],
        events: [
          { action: "add", requirementId: "threshold", normalized: "订单满 100 元减 20 元", source: { messageId: "u1", quote: "订单满 100 元减 20 元" } },
          { action: "add", requirementId: "single-use", normalized: "每张券只能使用一次", source: { messageId: "u1", quote: "每张券只能使用一次" } },
          { action: "add", requirementId: "expiry", normalized: "过期券不能用", source: { messageId: "u1", quote: "过期券不能用" } },
        ],
      } };
    }
    assert.deepEqual(input.knownRequirements.map(item => item.requirementId), ["threshold", "single-use", "expiry"]);
    return { model: "fixture-not-a-real-model", proposal: {
      dispositions: [
        { messageId: "u2", kind: "requirements", reason: "修改门槛" },
        { messageId: "u3", kind: "requirements", reason: "本次取消过期券要求" },
      ],
      events: [
        { action: "replace", requirementId: "threshold", normalized: "订单满 150 元减 20 元", source: { messageId: "u2", quote: "门槛改成满 150 元，其他规则不变。" } },
        { action: "cancel", requirementId: "expiry", source: { messageId: "u3", quote: "过期券这个要求先不做。" } },
      ],
    } };
  }
}

test("chunked conversation preserves unchanged rules and tracks replacement and cancellation", async () => {
  const intake = await fixture();
  const result = await resolveRequirements(intake, new FixtureGateway(), 45);
  assert.equal(result.resolutionComplete, true);
  assert.deepEqual(result.processing.map(item => item.status), ["processed", "processed"]);
  assert.deepEqual(result.unprocessedUserMessageIds, []);
  const active = currentRequirements(result.revisions);
  assert.deepEqual(active.map(item => [item.requirementId, item.revision, item.normalized]), [
    ["threshold", 2, "订单满 150 元减 20 元"],
    ["single-use", 1, "每张券只能使用一次"],
  ]);
  assert.equal(result.revisions.findLast(item => item.requirementId === "expiry")?.status, "cancelled");
  for (const revision of result.revisions) {
    for (const ref of revision.sourceRefs) {
      const message = intake.conversation.messages.find(item => item.id === ref.messageId);
      assert.equal(message?.text.slice(ref.start, ref.end), ref.quote);
    }
  }
});

test("fabricated quote rejects the whole model proposal and leaves user messages unprocessed", async () => {
  const intake = await fixture();
  const result = await resolveRequirements(intake, {
    async propose() {
      return { model: "fixture-not-a-real-model", proposal: {
        dispositions: [{ messageId: "u1", kind: "requirements" as const, reason: "claimed requirement" }],
        events: [{ action: "add" as const, requirementId: "invented", normalized: "满 200 元", source: { messageId: "u1", quote: "满 200 元" } }],
      } };
    },
  }, 45);
  assert.equal(result.resolutionComplete, false);
  assert.deepEqual(result.revisions, []);
  assert.deepEqual(result.unprocessedUserMessageIds, ["u1", "u2", "u3"]);
  assert.match(result.coverageIssues.join(" "), /Quote missing/);
});

test("declared missing transcript remains incomplete even when supplied messages were processed", async () => {
  const intake = await fixture();
  intake.conversation.transcriptCoverage.level = "partial";
  const partial = inspectConversation(intake.conversation);
  const result = await resolveRequirements(partial, new FixtureGateway(), 45);
  assert.equal(result.resolutionComplete, false);
  assert.deepEqual(result.unprocessedUserMessageIds, []);
  assert.match(result.coverageIssues.join(" "), /partial/);
});

test("a model response that skips a user message cannot complete requirement resolution", async () => {
  const intake = await fixture();
  const baseline = new FixtureGateway();
  const result = await resolveRequirements(intake, {
    async propose(input) {
      const output = await baseline.propose(input);
      if (input.messages.some(message => message.id === "u3")) {
        output.proposal.dispositions = output.proposal.dispositions.filter(item => item.messageId !== "u3");
      }
      return output;
    },
  }, 45);
  assert.equal(result.resolutionComplete, false);
  assert.deepEqual(result.unprocessedUserMessageIds, ["u2", "u3"]);
  assert.match(result.coverageIssues.join(" "), /Missing disposition for user message u3/);
});

test("a rejected proposal gets one validation-guided repair without changing earlier chunks", async () => {
  const intake = await fixture();
  const baseline = new FixtureGateway();
  let repairCalls = 0;
  const result = await resolveRequirements(intake, {
    async propose(input) {
      const output = await baseline.propose(input);
      if (input.messages.some(message => message.id === "u3")) {
        repairCalls++;
        if (!input.validationFeedback) output.proposal.events.reverse();
        else assert.match(input.validationFeedback, /not in message order/);
      }
      return output;
    },
  }, 45);
  assert.equal(repairCalls, 2);
  assert.equal(result.resolutionComplete, true);
  assert.equal(currentRequirements(result.revisions).find(item => item.requirementId === "threshold")?.normalized, "订单满 150 元减 20 元");
});

function attributedConversation(text: string) {
  return inspectConversation(ConversationSchema.parse({
    schemaVersion: 1,
    taskId: "external-advice",
    sessionId: "s1",
    host: "fixture",
    taskBoundary: { startMessageId: "u1", endMessageId: "u1" },
    transcriptCoverage: { level: "complete", source: "user_export", basis: "single-message fixture", missingMessageIds: [] },
    messages: [{ id: "u1", sequence: 1, role: "user", text }],
  }));
}

test("an attributed recommendation cannot become a requirement through a matching quote alone", async () => {
  const intake = attributedConversation("这是 DeepSeek 给我的建议：“证据必须签名并上传透明日志。”你不必觉得它是对的，请先评估这个方案。");
  const message = intake.conversation.messages[0]!;
  const ranges = attributedExternalRanges(message);
  assert.equal(ranges.length, 1);
  assert.equal(message.text.slice(ranges[0]!.start, ranges[0]!.end).includes("证据必须签名"), true);
  const result = await resolveRequirements(intake, {
    async propose() {
      return { model: "fixture-not-a-real-model", proposal: {
        dispositions: [{ messageId: "u1", kind: "requirements", reason: "模型误把转述当采纳" }],
        events: [{ action: "add", requirementId: "signed-evidence", normalized: "证据必须签名并上传透明日志", source: { messageId: "u1", quote: "证据必须签名并上传透明日志" } }],
      } };
    },
  });
  assert.equal(result.resolutionComplete, false);
  assert.deepEqual(result.revisions, []);
  assert.deepEqual(result.unprocessedUserMessageIds, []);
  assert.equal(result.dispositions[0]?.kind, "unresolved");
  assert.equal(result.processing[0]?.rejectedClaims?.[0]?.requirementId, "signed-evidence");
});

test("ordinary examples mentioning an agent are not treated as attributed recommendations", () => {
  const intake = attributedConversation("我平时使用 Codex 写代码。AI 有时说“已经完成”，但运行后还有 Bug。请让 VibeGuard 检查实际结果。");
  assert.deepEqual(attributedExternalRanges(intake.conversation.messages[0]!), []);
});

test("response annotations keep assistant selections separate from the user's comment", () => {
  const text = '<response-annotations>[{"text":"Codex 完成后应调用 VibeGuard。","annotation":"对就是这样，请按这个方案做。"}]</response-annotations>\n\n## My request:\n继续';
  const intake = attributedConversation(text);
  const ranges = attributedExternalRanges(intake.conversation.messages[0]!);
  assert.equal(ranges.length, 1);
  assert.equal(text.slice(ranges[0]!.start, ranges[0]!.end), "Codex 完成后应调用 VibeGuard。");
  assert.equal(text.slice(ranges[0]!.end).includes("对就是这样，请按这个方案做。"), true);
  const malformed = attributedConversation("<response-annotations>未闭合的引用");
  assert.deepEqual(attributedExternalRanges(malformed.conversation.messages[0]!), [{ start: 0, end: malformed.conversation.messages[0]!.text.length }]);
});

test("an external recommendation can be adopted only with a separate user decision outside the quote", async () => {
  const intake = attributedConversation("这是朋友的建议：“每张券只能使用一次。”我同意这条，请加入第一版。");
  const result = await resolveRequirements(intake, {
    async propose() {
      return { model: "fixture-not-a-real-model", proposal: {
        dispositions: [{ messageId: "u1", kind: "requirements", reason: "用户明确采纳" }],
        events: [{ action: "add", requirementId: "single-use", normalized: "每张券只能使用一次", source: { messageId: "u1", quote: "每张券只能使用一次" }, adoption: { messageId: "u1", quote: "我同意这条，请加入第一版" } }],
      } };
    },
  });
  assert.equal(result.resolutionComplete, true);
  assert.equal(result.revisions[0]?.sourceKind, "adopted_external");
  const refs = result.revisions[0]!.sourceRefs;
  assert.equal(refs.some(ref => ref.quote === "每张券只能使用一次"), true);
  assert.equal(refs.some(ref => ref.quote === "我同意这条，请加入第一版"), true);
  for (const ref of refs) assert.equal(intake.conversation.messages[0]!.text.slice(ref.start, ref.end), ref.quote);
});

test("asking to evaluate external advice does not block a separate direct instruction", async () => {
  const intake = attributedConversation("这是另一个 AI 的建议：“证据要上传透明日志。”请评估它。另外，请输出一份产品方案。");
  const result = await resolveRequirements(intake, {
    async propose() {
      return { model: "fixture-not-a-real-model", proposal: {
        dispositions: [{ messageId: "u1", kind: "requirements", reason: "仅保留用户直接提出的交付" }],
        events: [{ action: "add", requirementId: "product-plan", normalized: "输出一份产品方案", source: { messageId: "u1", quote: "请输出一份产品方案" } }],
      } };
    },
  });
  assert.equal(result.resolutionComplete, true);
  assert.deepEqual(currentRequirements(result.revisions).map(item => item.requirementId), ["product-plan"]);
});

test("an unnecessary adoption field cannot invalidate a direct user request", async () => {
  const intake = attributedConversation("请验证真实长任务验收能否在 Codex 里完成。");
  const result = await resolveRequirements(intake, {
    async propose() {
      return { model: "fixture-not-a-real-model", proposal: {
        dispositions: [{ messageId: "u1", kind: "requirements", reason: "用户直接要求" }],
        events: [{ action: "add", requirementId: "real-task", normalized: "在 Codex 里验收真实长任务", source: { messageId: "u1", quote: "请验证真实长任务验收能否在 Codex 里完成" }, adoption: { messageId: "u1", quote: "能否" } }],
      } };
    },
  });
  assert.equal(result.resolutionComplete, true);
  assert.equal(result.revisions[0]?.sourceKind, "explicit_user");
});
