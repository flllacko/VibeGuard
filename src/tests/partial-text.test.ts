import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { ConversationSchema, inspectConversation, type Conversation } from "../intake.js";
import { canInterpretPartialText } from "../material-policy.js";
import { freezePlan } from "../planning.js";
import type { GatewayInput, RequirementGateway } from "../requirements.js";
import { readResolution } from "../resolution-storage.js";
import { registerTask } from "../task-registry.js";
import { proposeTaskScope, readTaskIntake, scopeConfirmationReply, selectTaskScope, type ScopeProposal, type TaskScopeGateway } from "../task-scope.js";
import { VerificationService } from "../verification-service.js";
import { fixtureUnitCoverage } from "./fixture-unit-coverage.js";

function conversation(): Conversation {
  return ConversationSchema.parse({
    schemaVersion: 1, taskId: "partial-text", sessionId: "partial-text-session", host: "codex-app-server",
    taskBoundary: { startMessageId: "u0", endMessageId: "u3" },
    transcriptCoverage: { level: "partial", source: "host_adapter", basis: "任务范围待确认；一项前文截图尚未解析。", missingMessageIds: [] },
    hostCapture: { allReturnedPagesRead: true, scopeOnlyGap: true, unparsedUserContent: [{ messageId: "u0", count: 1 }] },
    messages: [
      { id: "u0", role: "user", text: "这个界面是项目背景，见截图。" },
      { id: "a0", role: "assistant", text: "已收到项目背景。" },
      { id: "u1", role: "user", text: "后续功能都要保留登录状态。" },
      { id: "a1", role: "assistant", text: "会保留登录状态。" },
      { id: "u2", role: "user", text: "增加修改密码功能。" },
      { id: "a2", role: "assistant", text: "已增加修改密码。" },
      { id: "u3", role: "user", text: "验收刚才这项任务。" },
    ].map((message, index) => ({ ...message, sequence: index + 1 })),
  });
}

function proposal(): ScopeProposal {
  return {
    candidates: [{
      candidateId: "S1", title: "修改密码", startMessageId: "u2", endMessageId: "a2",
      contextMessageIds: ["u0", "a0", "u1", "a1"],
      sourceRefs: [{ messageId: "u2", quote: "增加修改密码功能。" }, { messageId: "u1", quote: "后续功能都要保留登录状态。" }],
      reason: "本次任务是修改密码；带入项目背景及保留登录状态的约束。",
    }],
    ambiguities: [],
  };
}

const scopeGateway: TaskScopeGateway = {
  policyId: "partial-text-scope-fixture-v1",
  async propose() { return { proposal: proposal(), model: "fixture" }; },
};

async function saveTask(directory: string, source: Conversation) {
  const path = join(directory, `${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(source, null, 2) + "\n");
  return registerTask(directory, path, "checkpoint");
}

async function fixture(directory: string, changeParent?: (source: Conversation) => void, changeConfirmation?: (source: Conversation) => void) {
  await mkdir(directory, { recursive: true });
  const source = conversation();
  changeParent?.(source);
  const parent = await saveTask(directory, source);
  const stored = await proposeTaskScope(directory, parent, await readTaskIntake(directory, parent), scopeGateway);
  const fresh = structuredClone(source);
  fresh.messages.push({ id: "ask", sequence: fresh.messages.length + 1, role: "assistant", text: "是否选择修改密码范围并带入列出的前文？" });
  fresh.messages.push({ id: "choice", sequence: fresh.messages.length + 1, role: "user", text: scopeConfirmationReply(stored.proposalRef, "S1") });
  fresh.taskBoundary.endMessageId = "choice";
  // Independently simulate a fresh complete reply capture. This does not
  // repair the old parent, which remains the selected task's source.
  fresh.transcriptCoverage.missingMessageIds = [];
  if (fresh.hostCapture) fresh.hostCapture.allReturnedPagesRead = true;
  changeConfirmation?.(fresh);
  const current = await saveTask(directory, fresh);
  const selected = await selectTaskScope(directory, current.taskRef, { proposalRef: stored.proposalRef, candidateId: "S1" });
  return { source, parent, stored, current, selected, intake: await readTaskIntake(directory, selected) };
}

async function cleanup(directory: string) {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  await rm(directory, { recursive: true, force: true });
}

function requirementProposal(input: GatewayInput) {
  return fixtureUnitCoverage(input, {
    dispositions: [
      { messageId: "u0", kind: "discussion", reason: "已知截图未解析，仅保留同条消息的文字背景。" },
      { messageId: "u1", kind: "requirements", reason: "明确的文字约束。" },
      { messageId: "u2", kind: "requirements", reason: "本次文字目标。" },
    ],
    events: [
      { action: "add", requirementId: "keep-login", normalized: "修改密码保留登录状态", source: { messageId: "u1", quote: "后续功能都要保留登录状态。" } },
      { action: "add", requirementId: "password", normalized: "增加修改密码功能", source: { messageId: "u2", quote: "增加修改密码功能。" } },
    ],
  });
}

test("confirmed scope with only unparsed context content can expose text candidates without changing material completeness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-partial-text-"));
  try {
    const { intake, parent } = await fixture(directory);
    const original = JSON.stringify(intake);
    assert.equal(await canInterpretPartialText(directory, intake), true);
    assert.equal(JSON.stringify(intake), original, "eligibility must not mutate the selected snapshot");
    assert.equal(intake.conversation.transcriptCoverage.level, "partial");
    assert.ok(intake.coverageIssues.length > 0);
    assert.deepEqual(intake.conversation.materialGaps?.[0]?.messageIds, ["u0"]);
    assert.equal(intake.conversation.messages[0]!.text, "这个界面是项目背景，见截图。");
    assert.equal((await readTaskIntake(directory, parent)).conversation.transcriptCoverage.level, "partial");
  } finally { await cleanup(directory); }
});

test("partial text policy refuses work images, unread pages, unknown coverage, missing records and malformed mappings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-partial-text-block-"));
  try {
    for (const kind of ["work-image", "unread-page", "missing-message", "unknown-history", "summary", "sequence", "mapping", "unconfirmed", "unknown-gap-id"] as const) {
      const selectedDirectory = join(directory, kind);
      const { intake } = await fixture(selectedDirectory, source => {
        if (kind === "work-image") source.hostCapture!.unparsedUserContent.push({ messageId: "u2", count: 1 });
        if (kind === "unread-page") source.hostCapture!.allReturnedPagesRead = false;
        if (kind === "missing-message") source.transcriptCoverage.missingMessageIds = ["unread-user-message"];
        if (kind === "unknown-history") source.materialGaps = [{ kind: "history_coverage_unknown", messageIds: [], detail: "存在无法定位的缺页。" }];
      });
      const changed = structuredClone(intake.conversation);
      if (kind === "summary") changed.transcriptCoverage.source = "agent_summary";
      if (kind === "sequence") changed.messages[1]!.sequence += 10;
      if (kind === "mapping") changed.selectedScope!.originalSequences[1]!.sequence += 10;
      if (kind === "unconfirmed") delete changed.selectedScope;
      if (kind === "unknown-gap-id") changed.materialGaps![0]!.messageIds = ["not-in-selected-material"];
      if (kind === "sequence") {
        // The intake layer already refuses this structurally invalid message order.
        assert.throws(() => inspectConversation(changed), /strictly increasing/);
      } else {
        assert.equal(await canInterpretPartialText(selectedDirectory, inspectConversation(changed)), false, kind);
      }
    }
  } finally { await cleanup(directory); }
});

test("partial text eligibility is bound to parent bytes, the saved proposal, and the actual confirmation source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-partial-text-origin-"));
  try {
    for (const kind of ["parent-bytes", "proposal-bytes", "confirmation-bytes", "selected-text", "gap-count", "confirmation-reference", "work-as-context"] as const) {
      const selectedDirectory = join(directory, kind);
      const data = await fixture(selectedDirectory);
      let intake = data.intake;
      if (kind === "parent-bytes" || kind === "confirmation-bytes") {
        const hash = kind === "parent-bytes" ? data.parent.conversationSha256 : data.current.conversationSha256;
        const path = join(selectedDirectory, "conversations", `${hash}.json`);
        const source = JSON.parse(await readFile(path, "utf8")) as Conversation;
        source.messages[0]!.text = "已被修改的历史。";
        await writeFile(path, JSON.stringify(source, null, 2) + "\n");
      } else if (kind === "proposal-bytes") {
        const path = join(selectedDirectory, "task-scopes", `${data.stored.proposalRef}.json`);
        const saved = JSON.parse(await readFile(path, "utf8"));
        saved.candidates[0].contextMessageIds = ["u1", "a1"];
        await writeFile(path, JSON.stringify(saved, null, 2) + "\n");
      } else {
        const changed = structuredClone(intake.conversation);
        if (kind === "selected-text") changed.messages.find(item => item.id === "u2")!.text = "增加支付功能。";
        if (kind === "gap-count") changed.materialGaps![0]!.count = 2;
        if (kind === "confirmation-reference") changed.selectedScope!.confirmation.messageId = "not-the-user-choice";
        if (kind === "work-as-context") {
          changed.selectedScope!.workMessageIds = ["a2"];
          changed.selectedScope!.contextMessageIds.push("u2");
        }
        intake = inspectConversation(changed);
      }
      assert.equal(await canInterpretPartialText(selectedDirectory, intake), false, kind);
    }
  } finally { await cleanup(directory); }
});

test("partial text service keeps material gaps, original quotes and UNVERIFIABLE after all visible text is classified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-partial-text-service-"));
  let calls = 0;
  const gateway: RequirementGateway = { policyId: "partial-text-fixture-v1", async propose(input) {
    calls++;
    assert.deepEqual(input.materialGaps?.map(item => item.messageIds), [["u0"]]);
    assert.deepEqual(input.selectedScope?.contextMessageIds, ["u0", "a0", "u1", "a1"]);
    assert.deepEqual(input.taskFocus, { title: "修改密码", workUserMessages: [{ sequence: 5, text: "增加修改密码功能。" }], workMessages: [
      { sequence: 5, role: "user", text: "增加修改密码功能。" }, { sequence: 6, role: "assistant", text: "已增加修改密码。" },
    ] });
    return { model: "fixture", proposal: requirementProposal(input) };
  } };
  try {
    const data = await fixture(directory);
    const service = new VerificationService(directory, gateway, "fixture", scopeGateway);
    const run = await service.request(data.selected.taskRef);
    const result = await service.wait(run.runId as string) as Record<string, any>;
    assert.equal(calls, 1);
    assert.equal(result.verdict, "UNVERIFIABLE");
    assert.equal(result.gapStage, "material");
    assert.equal(result.requirementsStatus, "partial_text_candidates");
    assert.equal(result.textCoverage.allVisibleTextAccounted, true);
    assert.equal(result.requirements.length, 2);
    assert.ok(result.requirements.every((item: any) => item.verdict === "UNVERIFIABLE" && item.evidenceIds.length === 0));
    assert.deepEqual(result.materialGaps, data.intake.conversation.materialGaps);
    assert.deepEqual(result.selectedScope, data.intake.conversation.selectedScope);
    assert.equal(result.requirements[1].sourceRefs[0].quote, "增加修改密码功能。");
    const resolution = await readResolution(result.resolutionId, directory);
    assert.equal(resolution.resolutionComplete, false);
    assert.equal(resolution.transcriptCoverage.level, "partial");
    assert.deepEqual(resolution.coverageIssues, data.intake.coverageIssues);
    assert.throws(() => freezePlan(resolution, { criteria: [], coverage: [] }, "manual-fixture"), /incomplete|unresolved/);
    const restarted = new VerificationService(directory, gateway, "fixture", scopeGateway);
    const reread = await restarted.get(result.runId) as Record<string, any>;
    assert.equal(reread.requirementsStatus, "partial_text_candidates");
    assert.equal(reread.verdict, "UNVERIFIABLE");
    assert.deepEqual(reread.materialGaps, result.materialGaps);
    assert.deepEqual(reread.selectedScope, result.selectedScope);
    assert.equal(calls, 1, "reading a persisted report must not generate another proposal");
  } finally { await cleanup(directory); }
});

test("a complete flag cannot discharge attachment gaps or make partial candidates executable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-partial-text-flag-"));
  try {
    const { intake } = await fixture(directory);
    const changed = structuredClone(intake.conversation);
    changed.transcriptCoverage.level = "complete";
    const inspected = inspectConversation(changed);
    assert.ok(inspected.coverageIssues.includes(changed.materialGaps![0]!.detail));
    assert.equal(await canInterpretPartialText(directory, inspected), false, "changing the selected snapshot is not a valid way to resolve its material gap");
  } finally { await cleanup(directory); }
});

test("service does not send unresolved work images to the requirement model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-partial-text-work-"));
  let calls = 0;
  const gateway: RequirementGateway = { async propose(): Promise<never> { calls++; throw new Error("must not be called for unparsed work images"); } };
  try {
    const { selected } = await fixture(directory, source => { source.hostCapture!.unparsedUserContent.push({ messageId: "u2", count: 1 }); });
    const service = new VerificationService(directory, gateway, "fixture", scopeGateway);
    const pending = await service.request(selected.taskRef);
    const result = await service.wait(pending.runId as string);
    assert.equal(result.verdict, "UNVERIFIABLE");
    assert.equal(result.gapStage, "material");
    assert.equal(calls, 0);
    assert.deepEqual(result.requirements, []);
  } finally { await cleanup(directory); }
});

test("partial text remains blocked when the original choice was captured without a non-text ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-partial-text-legacy-choice-"));
  try {
    const { intake } = await fixture(directory, undefined, fresh => { delete fresh.hostCapture; });
    assert.equal(intake.conversation.selectedScope!.confirmation.messageId, "choice");
    assert.equal(intake.conversation.transcriptCoverage.level, "partial");
    assert.equal(await canInterpretPartialText(directory, intake), false);
    assert.ok(intake.conversation.materialGaps!.some(gap => gap.kind === "history_coverage_unknown"));
  } finally { await cleanup(directory); }
});
