import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ConversationSchema, inspectConversation } from "../intake.js";
import { requirementModelPayload } from "../pi-gateway.js";
import { currentRequirements, resolveRequirements, type GatewayInput, type GatewayOutput, type RequirementGateway } from "../requirements.js";

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

class FixtureGateway implements RequirementGateway {
  async propose(input: GatewayInput): Promise<GatewayOutput> {
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
