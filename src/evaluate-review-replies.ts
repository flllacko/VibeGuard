/** Explicit developer evaluation entry point. `prepare` is offline; `run` calls a paid model. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ConversationSchema, type Conversation } from "./intake.js";
import { intentUnits } from "./intent-units.js";
import { selectModel } from "./model-selection.js";
import { PiReviewReplyGateway } from "./pi-review-reply-gateway.js";
import { createRequirementReview, readRequirementReview, requirementReviewView } from "./requirement-review.js";
import { reviewReplyInput, reviewReplyInputHash } from "./review-reply-intent.js";
import { saveResolution } from "./resolution-storage.js";
import type { Resolution } from "./requirements.js";
import { sha256 } from "./storage.js";
import { registerTask } from "./task-registry.js";
import { VerificationService } from "./verification-service.js";

const CaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  requirements: z.array(z.object({ text: z.string().min(1), status: z.enum(["active", "cancelled"]).optional() }).strict()).min(1),
  questions: z.array(z.object({ quote: z.string().min(1), reason: z.string().min(1) }).strict()).optional(),
  answer: z.string().min(1),
  expected: z.object({ status: z.enum(["awaiting_review", "needs_clarification", "confirmed"]),
    actions: z.array(z.object({ action: z.string(), target: z.string().optional() }).strict()), unchanged: z.array(z.string()).optional(), activeCount: z.number().int().optional(),
    semanticChecks: z.array(z.object({ displayId: z.string(), includes: z.array(z.string()), excludes: z.array(z.string()).optional() }).strict()), notes: z.string(),
  }).strict(),
}).strict();
type EvaluationCase = z.infer<typeof CaseSchema>;
const PreparedCaseSchema = z.object({ case: CaseSchema, taskRef: z.string().uuid(), reviewRef: z.string().uuid(), freshTaskRef: z.string().uuid(), inputHash: z.string() }).strict();
const ManifestSchema = z.object({ schemaVersion: z.literal(1), origin: z.literal("synthetic_developer_authored"), preparedAt: z.string(),
  model: z.object({ provider: z.literal("deepseek"), id: z.literal("deepseek-flash") }).strict(), policyId: z.string(), caseSetSha256: z.string(),
  cases: z.array(PreparedCaseSchema).min(1).max(20), meaning: z.string(),
}).strict();
type Manifest = z.infer<typeof ManifestSchema>;

async function register(dataDir: string, conversation: Conversation, path: string) {
  await writeFile(path, JSON.stringify(conversation, null, 2) + "\n", { flag: "wx" });
  return registerTask(dataDir, path);
}
async function prepareCase(dataDir: string, sample: EvaluationCase) {
  const caseDir = join(dataDir, "samples", sample.id); await mkdir(caseDir, { recursive: true });
  const texts = [...sample.requirements.map(item => item.text), ...(sample.questions ?? []).map(item => item.quote)];
  const messages = texts.map((text, index) => ({ id: `u${index + 1}`, sequence: index + 1, role: "user" as const, text }));
  const conversation = ConversationSchema.parse({ schemaVersion: 1, taskId: `synthetic-review-${sample.id}-${randomUUID()}`, sessionId: randomUUID(), host: "synthetic-evaluation",
    transcriptCoverage: { level: "complete", source: "host_adapter", basis: "开发助手事先编写的合成材料，仅用于模型及代码联调；不是平台真人采集。", missingMessageIds: [] },
    taskBoundary: { startMessageId: messages[0]!.id, endMessageId: messages.at(-1)!.id }, messages,
  });
  const task = await register(dataDir, conversation, join(caseDir, "original.json"));
  const resolution: Resolution = { schemaVersion: 1, resolutionId: randomUUID(), taskId: conversation.taskId, createdAt: new Date().toISOString(), conversationSha256: task.conversationSha256,
    transcriptCoverage: conversation.transcriptCoverage, coverageIssues: sample.questions?.length ? ["存在尚未解释的用户原文片段"] : [],
    revisions: sample.requirements.map((item, index) => ({ requirementId: `goal-${index + 1}`, revision: 1, status: item.status ?? "active", normalized: item.text, sourceKind: "explicit_user",
      sourceRefs: [{ messageId: messages[index]!.id, start: 0, end: item.text.length, quote: item.text }] })),
    dispositions: messages.map((message, index) => ({ messageId: message.id, kind: index < sample.requirements.length ? "requirements" : "unresolved", reason: "预先编写的合成清单；不是自动要求提取准确率证据。" })),
    interpretedUnits: intentUnits(messages).map(unit => {
      const index = messages.findIndex(message => message.id === unit.messageId), isRequirement = index < sample.requirements.length;
      return { ...unit, kind: isRequirement ? "requirement" : "unresolved", requirementIds: isRequirement ? [`goal-${index + 1}`] : [], reason: isRequirement ? "样本给定的当前要求" : sample.questions![index - sample.requirements.length]!.reason };
    }),
    processing: [{ chunk: 1, messageIds: messages.map(message => message.id), status: "processed", model: "synthetic-precondition" }], unprocessedUserMessageIds: [], resolutionComplete: !sample.questions?.length,
  };
  await saveResolution(resolution, dataDir);
  const review = await createRequirementReview(dataDir, task.taskRef, resolution.resolutionId);
  const current = structuredClone(conversation);
  current.messages.push({ id: randomUUID(), sequence: current.messages.length + 1, role: "assistant", text: requirementReviewView(review).text });
  current.messages.push({ id: randomUUID(), sequence: current.messages.length + 1, role: "user", text: sample.answer });
  current.taskBoundary.endMessageId = current.messages.at(-1)!.id;
  const fresh = await register(dataDir, current, join(caseDir, "reply.json"));
  const input = reviewReplyInput(review, sample.answer);
  return { entry: { case: sample, taskRef: task.taskRef, reviewRef: review.reviewRef, freshTaskRef: fresh.taskRef, inputHash: reviewReplyInputHash(input) }, input };
}

export async function prepareReviewEvaluation(casePath: string, outputDir: string) {
  const bytes = await readFile(casePath);
  const cases = z.array(CaseSchema).min(1).max(20).parse(JSON.parse(bytes.toString("utf8")));
  if (new Set(cases.map(item => item.id)).size !== cases.length) throw new Error("评估案例编号重复。");
  await mkdir(outputDir, { recursive: true });
  const dataDir = join(outputDir, "data");
  const prepared = [];
  for (const sample of cases) prepared.push(await prepareCase(dataDir, sample));
  const model = selectModel("deepseek", undefined);
  const manifest: Manifest = { schemaVersion: 1, origin: "synthetic_developer_authored", preparedAt: new Date().toISOString(),
    model: { provider: "deepseek", id: "deepseek-flash" }, policyId: new PiReviewReplyGateway(model.piProvider, model.modelId).policyId, caseSetSha256: sha256(bytes),
    cases: prepared.map(item => item.entry), meaning: "参考答案在真实API调用前保存，且不会传给模型。合成样本由开发助手起草，未经过用户逐条审定，不代表真人平台验收或总体准确率。" };
  await writeFile(join(outputDir, "case-set.json"), bytes, { flag: "wx" });
  await writeFile(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  await writeFile(join(outputDir, "outgoing-inputs.json"), JSON.stringify(prepared.map((item, index) => ({ caseId: cases[index]!.id, input: item.input })), null, 2) + "\n", { flag: "wx" });
  await writeFile(join(outputDir, "outgoing-review.md"), "# 计划发送的合成材料\n\n仅发送当前清单、待定问题与样本回复；不含真实聊天、目录、密钥或参考答案。供应商：DeepSeek 官方 API；模型：Flash。\n\n" + cases.map(sample => `## ${sample.id}\n\n清单：\n${sample.requirements.map((item, i) => `- R${i + 1}：${item.text}`).join("\n")}\n\n回复：${sample.answer}\n`).join("\n"), { flag: "wx" });
  return { manifest: join(outputDir, "manifest.json"), cases: cases.length, modelCalls: 0, caseSetSha256: manifest.caseSetSha256 };
}

export async function runReviewEvaluation(manifestPath: string) {
  const frozenBytes = await readFile(manifestPath), manifest = ManifestSchema.parse(JSON.parse(frozenBytes.toString("utf8")));
  const outputDir = dirname(manifestPath), dataDir = join(outputDir, "data"), records: Record<string, unknown>[] = [];
  try { await readFile(join(outputDir, "summary.json")); throw new Error("本轮已有结果；请另存新的评估轮次，不能覆盖。"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const caseBytes = await readFile(join(outputDir, "case-set.json"));
  if (sha256(caseBytes) !== manifest.caseSetSha256 || JSON.stringify(z.array(CaseSchema).parse(JSON.parse(caseBytes.toString("utf8")))) !== JSON.stringify(manifest.cases.map(item => item.case))) throw new Error("预先保存的案例与参考答案发生改变。");
  const model = selectModel("deepseek", undefined), gateway = new PiReviewReplyGateway(model.piProvider, model.modelId, dataDir);
  if (gateway.policyId !== manifest.policyId) throw new Error("提示词或模型已变化；请另存新一轮评估，不覆盖原始结果。");
  let gatewayInvocations = 0, stopReason: string | undefined;
  for (const entry of manifest.cases) {
    if (sha256(await readFile(manifestPath)) !== sha256(frozenBytes)) throw new Error("运行期间评估清单发生变化。");
    const sample = entry.case, start = Date.now();
    const service = new VerificationService(dataDir, { async propose() { throw new Error("本评估不重新提取历史要求。"); } }, "live-review-evaluation", undefined, {
      policyId: gateway.policyId,
      async propose(input, validationFeedback) {
        if (reviewReplyInputHash(input) !== entry.inputHash) throw new Error("待发送材料与预先登记内容不一致。");
        gatewayInvocations++; return gateway.propose(input, validationFeedback);
      },
    });
    try {
      const result = await service.request(entry.freshTaskRef, false, undefined, { reviewRef: entry.reviewRef });
      const view = result.requirementReview as ReturnType<typeof requirementReviewView>;
      const review = await readRequirementReview(dataDir, view.reviewRef);
      const reread = await new VerificationService(dataDir, { async propose() { throw new Error("读回不得调用模型。"); } }, "read-only-observer").get(result.runId as string);
      const source = await readRequirementReview(dataDir, entry.reviewRef);
      const changedActions = review.changes.filter(change => change.kind !== "unknown").map(change => ({ action: change.kind, targets: change.targets }));
      const record = { caseId: sample.id, runId: result.runId, reviewRef: review.reviewRef, elapsedMs: Date.now() - start, modelMode: review.interpretation?.mode ?? "confirmation_fast_path",
        failureStage: review.interpretation?.mode === "unavailable" ? review.interpretation.failureStage : undefined,
        actual: { status: review.status, changes: changedActions, requirements: review.items.map(({ displayId, status, normalized }) => ({ displayId, status, normalized })), questions: review.unresolved },
        structuralChecks: { expectedStatusMatches: review.status === sample.expected.status, evidenceNotInvented: result.verdict === "UNVERIFIABLE" && (result.requirements as { evidenceIds: string[] }[]).every(item => !item.evidenceIds.length),
          materialIssuesPreserved: JSON.stringify(review.materialIssues) === JSON.stringify(source.materialIssues), persistedReadbackMatches: JSON.stringify(result) === JSON.stringify({ ...reread, reused: result.reused }) },
        expected: sample.expected, semanticReview: "pending_developer_inspection", interpretation: review.interpretation };
      records.push(record);
      await writeFile(join(outputDir, `${sample.id}.result.json`), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
      console.log(JSON.stringify({ caseId: sample.id, mode: record.modelMode, status: review.status, expectedStatus: sample.expected.status, elapsedMs: record.elapsedMs }));
      if (review.interpretation?.mode === "unavailable" && review.interpretation.failureStage === "model") stopReason = "模型未成功返回候选，停止后续付费调用；保留失败，不把剩余案例算通过。";
    } catch (error) {
      records.push({ caseId: sample.id, elapsedMs: Date.now() - start, error: error instanceof Error ? error.message : String(error), semanticReview: "not_completed" });
      stopReason = "评估流程异常，停止后续调用并保留已取得结果。";
    }
    await writeFile(join(outputDir, "progress.json"), JSON.stringify({ totalCases: manifest.cases.length, gatewayInvocations, stopReason, records }, null, 2) + "\n");
    if (stopReason) break;
  }
  let responses: { usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number }; stopReason: string }[] = [];
  try {
    for (const name of await readdir(join(dataDir, "review-model-attempts"))) responses.push(JSON.parse(await readFile(join(dataDir, "review-model-attempts", name), "utf8")));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const summary = { schemaVersion: 1, model: manifest.model, policyId: manifest.policyId, caseSetSha256: manifest.caseSetSha256,
    totalCases: manifest.cases.length, processedCases: records.length, unprocessedCases: manifest.cases.length - records.length, gatewayInvocations,
    capturedModelResponses: responses.length, completeModelResponses: responses.filter(item => item.stopReason === "stop").length,
    usage: responses.reduce((sum, item) => ({ inputTokens: sum.inputTokens + item.usage.inputTokens, outputTokens: sum.outputTokens + item.usage.outputTokens, estimatedCostUsd: sum.estimatedCostUsd + item.usage.estimatedCostUsd }), { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }),
    elapsedMs: records.reduce((sum, item) => sum + Number(item.elapsedMs), 0), stopReason, records,
    limitations: ["仅评估模型解释修订与程序接线，不是业务验收完成。", "参考答案由开发助手事先编写，尚未由用户逐条审定。", "状态和结构检查不等于语义准确率；需逐条核对规范化要求、排除内容和歧义。", "没有真人在Agent平台点击或回复，不能宣布真实宿主交互已通过。"] };
  await writeFile(join(outputDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  return { processedCases: summary.processedCases, capturedModelResponses: summary.capturedModelResponses, usage: summary.usage, stopReason, report: join(outputDir, "summary.json") };
}

async function main() {
  const args = process.argv.slice(2), command = args.shift();
  const option = (flag: string) => { const index = args.indexOf(flag); if (index < 0 || !args[index + 1]) throw new Error(`缺少 ${flag}`); return resolve(args[index + 1]!); };
  const result = command === "prepare" ? await prepareReviewEvaluation(option("--cases"), option("--out")) : command === "run" ? await runReviewEvaluation(option("--manifest")) : (() => { throw new Error("使用 prepare --cases FILE --out DIR 离线准备；run --manifest FILE 才会调用付费模型。"); })();
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
