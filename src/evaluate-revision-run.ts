/** Explicit synthetic evaluation: offline prepare, then paid model calls and real Docker execution. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Conversation } from "./intake.js";
import { createExternalPlan, externalPlanInput, reuseExternalPlan } from "./external-plan.js";
import { prepareExternalProject } from "./external-project.js";
import { readExternalRun, renderExternalRun, runExternalPlan } from "./external-runner.js";
import { ApiProfileSchema, PiPlanGateway } from "./pi-plan-gateway.js";
import { PiReviewReplyGateway } from "./pi-review-reply-gateway.js";
import { selectModel } from "./model-selection.js";
import { applyRequirementReviewReply, readRequirementReview, requirementReviewView, type StoredRequirementReview } from "./requirement-review.js";
import { reviewReplyInput } from "./review-reply-intent.js";
import { readTask, registerTask } from "./task-registry.js";
import { readTaskIntake } from "./task-scope.js";
import { sha256 } from "./storage.js";
import { prepareRuntimeFixture } from "./tests/helpers/external-project-fixture.js";

const OracleSchema = z.array(z.object({ method: z.enum(["GET", "POST"]), path: z.string(), body: z.unknown().optional(),
  expectedStatus: z.number().int(), pointer: z.string(), equals: z.unknown() }).strict()).min(1).max(12);
const CaseSchema = z.object({ schemaVersion: z.literal(1), id: z.string().regex(/^[a-z][a-z0-9-]*$/), origin: z.literal("synthetic-developer-authored"),
  initial: z.object({ requirement: z.string().min(1), script: z.string().min(1), oracle: OracleSchema }).strict(),
  revision: z.object({ reply: z.string().min(1), expectedNormalized: z.object({ includes: z.array(z.string()).min(1), excludes: z.array(z.string()) }).strict(), oracle: OracleSchema }).strict(),
  updatedScript: z.string().min(1), apiProfile: ApiProfileSchema }).strict();
const ManifestSchema = z.object({ schemaVersion: z.literal(1), caseSha256: z.string(), initialInputSha256: z.string(), replyInputSha256: z.string(),
  projectRef: z.string().uuid(), reviewRef: z.string().uuid(), profilePath: z.string(), initialTaskRef: z.string().uuid() }).strict();
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const save = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

/** Synthetic source reply, with the same review/prefix checks used by production; never a live user claim. */
export async function registerEvaluationReply(dataDir: string, conversation: Conversation, review: StoredRequirementReview, answer: string, path: string) {
  const fresh = structuredClone(conversation), suffix = randomUUID();
  fresh.messages.push({ id: `display-${suffix}`, role: "assistant", sequence: fresh.messages.length + 1, text: requirementReviewView(review).text });
  fresh.messages.push({ id: `reply-${suffix}`, role: "user", sequence: fresh.messages.length + 1, text: answer });
  fresh.taskBoundary.endMessageId = fresh.messages.at(-1)!.id;
  await save(path, fresh);
  return { conversation: fresh, task: await registerTask(dataDir, path) };
}

export async function prepareRevisionEvaluation(casePath: string, out: string) {
  if (!isAbsolute(out)) throw new Error("Use an absolute new output directory");
  const raw = await readFile(casePath), sample = CaseSchema.parse(JSON.parse(raw.toString("utf8")));
  await mkdir(out);
  await writeFile(join(out, "case.json"), raw, { flag: "wx" });
  const dataDir = join(out, "data"), fixture = await prepareRuntimeFixture(out, sample.initial.script, 5000, { dataDir, quote: sample.initial.requirement });
  const initialInput = (await externalPlanInput(dataDir, fixture.project.projectRef, sample.apiProfile)).modelInput;
  const review = await readRequirementReview(dataDir, fixture.project.reviewRef), replyInput = reviewReplyInput(review, sample.revision.reply);
  await save(join(out, "initial-model-input.json"), initialInput); await save(join(out, "reply-model-input.json"), replyInput);
  await save(join(out, "manifest.json"), { schemaVersion: 1, caseSha256: sha256(raw), initialInputSha256: sha256(JSON.stringify(initialInput)),
    replyInputSha256: sha256(JSON.stringify(replyInput)), projectRef: fixture.project.projectRef, reviewRef: review.reviewRef,
    profilePath: join(out, "project.json"), initialTaskRef: fixture.project.currentTaskRef });
  await writeFile(join(out, "outgoing-review.md"), "# 要求修订闭环：外发材料预览\n\n合成任务，原始要求及初始确认由程序预置，不是平台真人采集。\n供应商 DeepSeek 官方，deepseek-flash。预计初次规划、修订理解、新版规划各一次，结构反馈各最多一次，最多六次响应。规划每次最多 8000 输出 token，修订每次最多 3000。\n只发送要求、这条修订和接口契约；不发送源码、独立参考答案、密钥、其他聊天或变体标签。新版规划输入取真实模型修订后再确认的条目，届时另存 revised-model-input.json。\n\n## 初次规划\n```json\n" + JSON.stringify(initialInput, null, 2) + "\n```\n\n## 修订理解\n```json\n" + JSON.stringify(replyInput, null, 2) + "\n```\n", { flag: "wx" });
  return { out, projectRef: fixture.project.projectRef, modelCalls: 0 };
}

export async function runRevisionEvaluation(out: string) {
  const manifest = ManifestSchema.parse(await json(join(out, "manifest.json"))), raw = await readFile(join(out, "case.json")), sample = CaseSchema.parse(JSON.parse(raw.toString("utf8")));
  if (sha256(raw) !== manifest.caseSha256) throw new Error("Prepared revision case changed");
  const dataDir = join(out, "data"), selected = selectModel("deepseek", undefined), events: unknown[] = [], runs: { id: string; runId: string; verdict: string; evidenceIds: string[] }[] = [];
  await save(join(out, "run-start.json"), { startedAt: new Date().toISOString(), maxModelResponses: 6 });
  const event = async (body: unknown) => { events.push(body); await save(join(out, `event-${String(events.length).padStart(2, "0")}.json`), body); };
  const reject = async (label: string, expectedReason: RegExp, action: () => Promise<unknown>) => {
    let failure: unknown; try { await action(); } catch (error) { failure = error; }
    if (!failure) throw new Error(`${label}: obsolete or unconfirmed material was accepted`);
    if (!expectedReason.test(failure instanceof Error ? failure.message : String(failure))) throw new Error(`${label}: failed for an unexpected reason: ${String(failure)}`);
    await event({ label, rejected: true, reason: failure instanceof Error ? failure.message : String(failure) });
  };
  const execute = async (id: string, planRef: string, expected: string) => {
    const run = await runExternalPlan(dataDir, planRef);
    await writeFile(join(out, `${id}-report.md`), renderExternalRun(run) + "\n", { flag: "wx" });
    runs.push({ id, runId: run.runId, verdict: run.verdict, evidenceIds: run.evidenceIds });
    await event({ id, planRef, runId: run.runId, verdict: run.verdict, expected });
    if (run.verdict !== expected) throw new Error(`${id}: expected ${expected}, observed ${run.verdict}`);
    return run;
  };
  const assertOracle = (plan: Awaited<ReturnType<typeof createExternalPlan>>, oracle: z.infer<typeof OracleSchema>) => {
    const steps = plan.plan.criteria.flatMap(item => item.checks.flatMap(check => check.type === "http_sequence" ? check.steps : []));
    for (const wanted of oracle) if (!steps.some(step => step.method === wanted.method && step.pathTemplate === wanted.path && JSON.stringify(step.body) === JSON.stringify(wanted.body) &&
      step.expectedStatus === wanted.expectedStatus && step.assertions.some(assertion => assertion.pointer === wanted.pointer && JSON.stringify(assertion.equals) === JSON.stringify(wanted.equals)))) throw new Error("Model plan did not satisfy independent revision oracle");
  };
  try {
    const initialInput = await externalPlanInput(dataDir, manifest.projectRef, sample.apiProfile);
    if (sha256(JSON.stringify(initialInput.modelInput)) !== manifest.initialInputSha256) throw new Error("Initial outbound input changed");
    const planner = new PiPlanGateway(selected.piProvider, selected.modelId, dataDir), reviewGateway = new PiReviewReplyGateway(selected.piProvider, selected.modelId, dataDir);
    const original = await createExternalPlan(dataDir, manifest.projectRef, sample.apiProfile, planner);
    await save(join(out, "initial-plan.json"), original); assertOracle(original, sample.initial.oracle);
    const initialRun = await execute("initial", original.planRef, "VERIFIED");
    const initialReview = await readRequirementReview(dataDir, manifest.reviewRef), intake = await readTaskIntake(dataDir, await readTask(dataDir, manifest.initialTaskRef));
    if (sha256(JSON.stringify(reviewReplyInput(initialReview, sample.revision.reply))) !== manifest.replyInputSha256) throw new Error("Revision outbound input changed");
    const reply = await registerEvaluationReply(dataDir, intake.conversation, initialReview, sample.revision.reply, join(out, "revision-conversation.json"));
    const changed = await applyRequirementReviewReply(dataDir, reply.task.taskRef, { reviewRef: initialReview.reviewRef }, reviewGateway);
    await save(join(out, "revision-review.json"), changed);
    if (changed.status !== "awaiting_review" || changed.confirmation || changed.interpretation?.mode !== "model") throw new Error("Revision must be interpreted by the real model, then await a new confirmation");
    const normalized = changed.items.filter(item => item.status === "active").map(item => item.normalized).join("\n");
    for (const text of sample.revision.expectedNormalized.includes) if (!normalized.includes(text)) throw new Error(`Revised meaning lacks oracle term ${text}`);
    for (const text of sample.revision.expectedNormalized.excludes) if (normalized.includes(text)) throw new Error(`Revised meaning retains obsolete oracle term ${text}`);
    let obsoleteDockerCalls = 0;
    await reject("old-plan-after-revision", /superseded/, () => runExternalPlan(dataDir, original.planRef, { client: { async invoke() { obsoleteDockerCalls++; throw new Error("MUST_NOT_INVOKE_DOCKER"); } } }));
    if (obsoleteDockerCalls) throw new Error("Obsolete plan reached Docker before the revision guard");
    await event({ label: "old-plan-side-effects", dockerCalls: obsoleteDockerCalls });
    await reject("new-review-before-confirmation", /not been completely confirmed/, () => prepareExternalProject(dataDir, manifest.profilePath, changed.reviewRef, reply.task.taskRef));
    const confirmation = await registerEvaluationReply(dataDir, reply.conversation, changed, "确认", join(out, "confirmation-conversation.json"));
    const confirmed = await applyRequirementReviewReply(dataDir, confirmation.task.taskRef, { reviewRef: changed.reviewRef });
    const newProject = await prepareExternalProject(dataDir, manifest.profilePath, confirmed.reviewRef, confirmation.task.taskRef);
    await reject("reuse-old-plan-for-new-requirements", /superseded|identical reviewed requirements/, () => reuseExternalPlan(dataDir, original.planRef, newProject.project.projectRef));
    const revisedInput = (await externalPlanInput(dataDir, newProject.project.projectRef, sample.apiProfile)).modelInput;
    await save(join(out, "revised-model-input.json"), revisedInput);
    const revised = await createExternalPlan(dataDir, newProject.project.projectRef, sample.apiProfile, planner);
    await save(join(out, "revised-plan.json"), revised); assertOracle(revised, sample.revision.oracle);
    if (revised.requirementsSha256 === original.requirementsSha256 || revised.plan.planHash === original.plan.planHash) throw new Error("Revision reused an obsolete requirement or plan hash");
    await execute("old-delivery-new-requirements", revised.planRef, "FAILED");
    const profile = await json(manifest.profilePath);
    await writeFile(join(profile.projectRoot, "server.mjs"), sample.updatedScript);
    const repaired = await prepareExternalProject(dataDir, manifest.profilePath, confirmed.reviewRef, confirmation.task.taskRef);
    if (repaired.project.targetSnapshotHash === newProject.project.targetSnapshotHash) throw new Error("Delivery repair did not change the captured version");
    const rebound = await reuseExternalPlan(dataDir, revised.planRef, repaired.project.projectRef);
    const repairedRun = await execute("repaired-delivery", rebound.planRef, "VERIFIED");
    const archived = await readExternalRun(dataDir, initialRun.runId);
    if (archived.verdict !== "VERIFIED" || archived.planRef !== original.planRef || archived.targetSnapshotHash === repairedRun.targetSnapshotHash) throw new Error("Historical report was changed or rebound to the new delivery");
    await event({ label: "historical-report-preserved", runId: archived.runId, historicalVerdict: archived.verdict,
      historicalPlanRef: archived.planRef, currentPlanRef: rebound.planRef, meaning: "Old scope only; cannot prove the revised task" });
    const summary = { schemaVersion: 1, origin: sample.origin, caseId: sample.id, results: runs, events, failures: [],
      meaning: "Synthetic review/reconfirmation with real model interpretation, planning and Docker observations; not live host or human approval evidence." };
    await save(join(out, "summary.json"), summary); return summary;
  } catch (error) {
    await save(join(out, "failure.json"), { reason: error instanceof Error ? error.message : String(error), events, results: runs });
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2), mode = args.shift(), value = (name: string) => args[args.indexOf(name) + 1], out = value("--out");
  if (!args.includes("--out") || !out) throw new Error("Requires --out ABSOLUTE_NEW_DIRECTORY");
  if (mode === "prepare" && args.includes("--case") && value("--case")) console.log(JSON.stringify(await prepareRevisionEvaluation(value("--case")!, resolve(out))));
  else if (mode === "run" && args.includes("--allow-model") && args.includes("--allow-docker")) { const result = await runRevisionEvaluation(resolve(out)); console.log(JSON.stringify(result.results)); }
  else throw new Error("Use prepare --case FILE --out DIR, or run --out DIR --allow-model --allow-docker");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
