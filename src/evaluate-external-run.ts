/** Explicit developer evaluation. Prepare is offline; run spends API tokens and executes synthetic deliveries in Docker. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { createExternalPlan, externalPlanInput, externalPlanView, readExternalPlan, reuseExternalPlan } from "./external-plan.js";
import { readExternalEvidence, readExternalRun, renderExternalRun, runExternalPlan } from "./external-runner.js";
import { ApiProfileSchema, PiPlanGateway } from "./pi-plan-gateway.js";
import { selectModel } from "./model-selection.js";
import { sha256 } from "./storage.js";
import { prepareRuntimeFixture } from "./tests/helpers/external-project-fixture.js";
import { readExternalProject } from "./external-project.js";

const CaseSchema = z.object({ schemaVersion: z.literal(1), id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  requirement: z.string().min(1), origin: z.enum(["user-provided", "synthetic-developer-authored"]), apiProfile: ApiProfileSchema,
  confirmedRequirements: z.array(z.object({ requirementId: z.string().regex(/^[a-z][a-z0-9-]*$/), quote: z.string().min(1) }).strict()).min(1).max(20).optional(),
  expectedPlanningCoverage: z.array(z.object({ requirementId: z.string(), status: z.enum(["planned", "partial", "unverifiable"]) }).strict()).optional(),
  variants: z.array(z.object({ id: z.enum(["correct", "faulty", "unavailable"]), script: z.string().min(1),
    expectedVerdict: z.enum(["VERIFIED", "FAILED", "UNVERIFIABLE"]),
    expectedRequirements: z.record(z.string(), z.enum(["VERIFIED", "FAILED", "UNVERIFIABLE"])).optional() }).strict()).length(3),
  oracle: z.array(z.object({ method: z.enum(["GET", "POST"]), path: z.string(), body: z.unknown().optional(),
    expectedStatus: z.number().int(), pointer: z.string(), equals: z.unknown() }).strict()).min(2).max(12),
}).strict();
const ManifestSchema = z.object({ schemaVersion: z.literal(1), caseSha256: z.string(), preparedAt: z.string(),
  outgoingSha256: z.string(), projects: z.array(z.object({ id: z.enum(["correct", "faulty", "unavailable"]), projectRef: z.string().uuid() }).strict()).length(3),
}).strict();
function pointer(body: unknown, path: string): unknown {
  if (!path) return body;
  let value: any = body;
  for (const part of path.slice(1).split("/")) value = value?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  return value;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Oracle placeholders describe a resource shape, not a required planner capture variable name. */
export function oraclePathMatches(template: string, candidate: string): boolean {
  const expected = template.split("/"), actual = candidate.split("/");
  return expected.length === actual.length && expected.every((part, index) =>
    /^\{[A-Za-z][A-Za-z0-9_-]*\}$/.test(part) ? Boolean(actual[index]) : part === actual[index]);
}

export async function prepareExternalEvaluation(casePath: string, out: string) {
  if (!isAbsolute(out)) throw new Error("Use an absolute new output directory");
  const raw = await readFile(casePath), sample = CaseSchema.parse(JSON.parse(raw.toString("utf8")));
  if (new Set(sample.variants.map(item => item.id)).size !== 3 || sample.variants[0]!.id !== "correct") throw new Error("Variants must be unique and start with correct");
  await mkdir(out); // Never replace an earlier failed or successful evaluation.
  await writeFile(join(out, "case.json"), raw, { flag: "wx" });
  const dataDir = join(out, "data"), projects = [];
  for (const variant of sample.variants) {
    const root = join(out, variant.id); await mkdir(root);
    const fixture = await prepareRuntimeFixture(root, variant.script, 5000, { quote: sample.requirement, dataDir, requirements: sample.confirmedRequirements });
    projects.push({ id: variant.id, projectRef: fixture.project.projectRef });
  }
  const input = await externalPlanInput(dataDir, projects[0]!.projectRef, sample.apiProfile);
  const outgoing = JSON.stringify(input.modelInput, null, 2) + "\n";
  await writeFile(join(out, "outgoing-input.json"), outgoing, { flag: "wx" });
  const manifest = ManifestSchema.parse({ schemaVersion: 1, preparedAt: new Date().toISOString(), caseSha256: sha256(raw), outgoingSha256: sha256(outgoing), projects });
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  await writeFile(join(out, "outgoing-review.md"), "# D3 实测待发送材料\n\n供应商：DeepSeek 官方 API；模型：deepseek-flash。仅发送要求原话、规范化条目、引用和接口契约。\n不发送源码、其他聊天、目录、密钥、变体标签或参考答案。初次请求失败于结构/接口契约校验时，最多一次反馈修正；每次最多 8000 输出 token。认证、网络及不完整响应不自动重试。原始尝试均保留，实际调用数和用量累计。\n原话由样本提供；单条要求和确认记录由评估程序准备，不作为原聊天真人确认或提取准确率证据。\n\n```json\n" + outgoing + "```\n", { flag: "wx" });
  return { out, projects, modelCalls: 0, outgoingSha256: manifest.outgoingSha256 };
}

export async function runExternalEvaluation(out: string) {
  const manifest = ManifestSchema.parse(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")));
  const raw = await readFile(join(out, "case.json")), sample = CaseSchema.parse(JSON.parse(raw.toString("utf8")));
  const outgoing = await readFile(join(out, "outgoing-input.json"));
  if (sha256(raw) !== manifest.caseSha256 || sha256(outgoing) !== manifest.outgoingSha256) throw new Error("Prepared evaluation changed");
  // Exclusive marker prevents a repeated command from causing another paid call.
  await writeFile(join(out, "run-start.json"), JSON.stringify({ startedAt: new Date().toISOString(), maxModelCalls: 2 }) + "\n", { flag: "wx" });
  const dataDir = join(out, "data"), model = selectModel("deepseek", undefined), results = [];
  const currentInput = await externalPlanInput(dataDir, manifest.projects[0]!.projectRef, sample.apiProfile);
  if (!equal(currentInput.modelInput, JSON.parse(outgoing.toString("utf8")))) throw new Error("Actual planner payload differs from preview");
  const plan = await createExternalPlan(dataDir, manifest.projects[0]!.projectRef, sample.apiProfile, new PiPlanGateway(model.piProvider, model.modelId, dataDir));
  await writeFile(join(out, "real-model-plan.json"), JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
  const failures: string[] = [];
  // Oracle is read only by this evaluator after generation. It never enters the model payload or runner arguments.
  for (const wanted of sample.expectedPlanningCoverage ?? []) {
    if (plan.plan.coverage.find(item => item.requirementId === wanted.requirementId)?.status !== wanted.status) failures.push(`Planning destination differs from independent oracle: ${wanted.requirementId}/${wanted.status}`);
  }
  const plannedSteps = plan.plan.criteria.flatMap(criterion => criterion.checks.flatMap(check => check.type === "http_sequence" ? check.steps : []));
  for (const wanted of sample.oracle) {
    if (!plannedSteps.some(step => step.method === wanted.method && oraclePathMatches(wanted.path, step.pathTemplate) && equal(step.body, wanted.body) && step.expectedStatus === wanted.expectedStatus &&
      step.assertions.some(assertion => assertion.pointer === wanted.pointer && equal(assertion.equals, wanted.equals)))) failures.push(`Plan did not contain required independent-oracle observation: ${JSON.stringify(wanted)}`);
  }
  for (const project of manifest.projects) {
    const variant = sample.variants.find(item => item.id === project.id)!;
    const bound = project.id === "correct" ? plan : await reuseExternalPlan(dataDir, plan.planRef, project.projectRef);
    if (!equal({ criteria: bound.plan.criteria, coverage: bound.plan.coverage }, { criteria: plan.plan.criteria, coverage: plan.plan.coverage })) throw new Error("Plan content changed across variants");
    const run = await runExternalPlan(dataDir, bound.planRef, { currentTaskRef: (await readExternalProject(dataDir, bound.projectRef)).project.currentTaskRef });
    await writeFile(join(out, `${project.id}-report.md`), renderExternalRun(run) + "\n", { flag: "wx" });
    const observed = [];
    for (const id of run.evidenceIds) observed.push(await readExternalEvidence(dataDir, run.runId, id));
    if (run.verdict !== variant.expectedVerdict) failures.push(`${project.id}: expected ${variant.expectedVerdict}, observed ${run.verdict}`);
    for (const [id, expected] of Object.entries(variant.expectedRequirements ?? {})) {
      if (run.coverage.requirements.find(item => item.requirementId === id)?.verdict !== expected) failures.push(`${project.id}/${id}: requirement verdict differs from independent oracle ${expected}`);
    }
    if (project.id === "correct") for (const wanted of sample.oracle) {
      if (!observed.some((item: any) => item.request.method === wanted.method && oraclePathMatches(wanted.path, new URL(item.request.url).pathname) && equal(item.request.body, wanted.body) && item.response?.status === wanted.expectedStatus && equal(pointer(item.response.body, wanted.pointer), wanted.equals))) failures.push(`Correct delivery lacks real oracle evidence: ${JSON.stringify(wanted)}`);
    }
    const restored = await readExternalRun(dataDir, run.runId);
    if (restored.verdict !== run.verdict) failures.push("Same-process readback mismatch");
    const row = { id: project.id, runId: run.runId, planRef: bound.planRef, projectRef: project.projectRef, verdict: run.verdict,
      expectedVerdict: variant.expectedVerdict, evidenceIds: run.evidenceIds, targetSnapshotHash: run.targetSnapshotHash, runtime: run.runtime, coverage: run.coverage };
    results.push(row); console.log(JSON.stringify(row));
  }
  const summary = { schemaVersion: 1, completedAt: new Date().toISOString(), origin: sample.origin, caseId: sample.id, requirement: sample.requirement,
    modelCalls: plan.generation.modelCalls ?? 1, generation: plan.generation, planRef: plan.planRef, samePlanContentAcrossVariants: true, results, failures,
    meaning: "真实模型规划与真实 Docker HTTP 观察；评估输入确认由程序准备，不是宿主真人接入验收。新进程读取需另行执行。" };
  await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  return summary;
}

/** Every report and evidence item is fetched by a new CLI process with no model credentials or Docker on PATH. */
export async function replayExternalEvaluation(out: string) {
  const summary = z.object({ results: z.array(z.object({ id: z.string(), runId: z.string().uuid(), verdict: z.enum(["VERIFIED", "FAILED", "UNVERIFIABLE"]),
    evidenceIds: z.array(z.string().uuid()) }).passthrough()) }).passthrough().parse(JSON.parse(await readFile(join(out, "summary.json"), "utf8")));
  const execute = promisify(execFile), cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const env = { ...process.env, DEEPSEEK_API_KEY: "", MOONSHOT_API_KEY: "", PATH: dirname(process.execPath) };
  const read = async (args: string[]) => JSON.parse((await execute(process.execPath, [cli, ...args, "--data-dir", join(out, "data")], { env, timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout);
  const results = [];
  for (const item of summary.results) {
    const report = await read(["project-report", item.runId, "--format", "json"]);
    if (report.runId !== item.runId || report.verdict !== item.verdict || !equal(report.evidenceIds, item.evidenceIds)) throw new Error("New-process report differs from original run");
    const evidence = [];
    for (const id of item.evidenceIds) {
      const record = await read(["project-evidence", item.runId, id]);
      if (record.evidenceId !== id) throw new Error("New-process evidence identity mismatch");
      evidence.push(record);
    }
    results.push({ id: item.id, runId: item.runId, verdict: report.verdict, evidenceCount: evidence.length, evidence, readbackSucceeded: true });
  }
  const result = { createdAt: new Date().toISOString(), originalVerificationProcessExited: true, noModelCredentialsOrDockerOnChildPath: true, results };
  await writeFile(join(out, "restarted-readback.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  return result;
}

async function main() {
  const args = process.argv.slice(2), mode = args.shift(), option = (name: string) => args[args.indexOf(name) + 1];
  const out = option("--out"); if (!args.includes("--out") || !out) throw new Error("Requires --out ABSOLUTE_DIRECTORY");
  if (mode === "prepare") { const path = option("--case"); if (!args.includes("--case") || !path) throw new Error("Requires --case FILE"); console.log(JSON.stringify(await prepareExternalEvaluation(path, resolve(out)))); }
  else if (mode === "run" && args.includes("--allow-model") && args.includes("--allow-docker")) { const result = await runExternalEvaluation(resolve(out)); process.exitCode = result.failures.length ? 2 : 0; }
  else if (mode === "readback") { const result = await replayExternalEvaluation(resolve(out)); console.log(JSON.stringify(result.results.map(({ evidence, ...item }) => item))); }
  else throw new Error("Use prepare --case FILE --out DIR, run --out DIR --allow-model --allow-docker, or readback --out DIR");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
