/** Developer-authored contrast evaluation, not live user requirement extraction or an overall accuracy estimate. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ApiProfileSchema, PiPlanGateway, planModelInput } from "./pi-plan-gateway.js";
import { freezePlan } from "./planning.js";
import { selectModel } from "./model-selection.js";
import type { Resolution } from "./requirements.js";
import { sha256 } from "./storage.js";

const CasesSchema = z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  requirements: z.array(z.object({ id: z.string(), text: z.string().min(1) }).strict()).min(1),
  apiProfile: ApiProfileSchema,
  // These independent expectations are frozen before calls and excluded from planModelInput.
  expected: z.object({
    coverage: z.record(z.string(), z.enum(["planned", "partial", "unverifiable"])),
    inputDomainOnly: z.object({ field: z.string(), type: z.enum(["integer", "string"]) }).strict().optional(),
    steps: z.array(z.object({ body: z.unknown(), status: z.number(), pointer: z.string(), equals: z.unknown() }).strict()),
    rejectedFraction: z.object({ field: z.string(), status: z.number(), pointer: z.string(), equals: z.unknown() }).strict().optional(),
  }).strict(),
}).strict()).min(1).max(12);

function resolution(sample: z.infer<typeof CasesSchema>[number]): Resolution {
  return { schemaVersion: 1, resolutionId: randomUUID(), taskId: "synthetic-input-domain", createdAt: new Date().toISOString(),
    conversationSha256: sha256(JSON.stringify(sample.requirements)),
    transcriptCoverage: { level: "complete", source: "user_export", basis: "Synthetic planning contrast only", missingMessageIds: [] },
    coverageIssues: [], revisions: sample.requirements.map((r, i) => ({ requirementId: r.id, revision: 1, status: "active", normalized: r.text,
      sourceKind: "explicit_user", sourceRefs: [{ messageId: `u${i + 1}`, start: 0, end: r.text.length, quote: r.text }] })),
    dispositions: [], processing: [], unprocessedUserMessageIds: [], resolutionComplete: true };
}

export async function prepareInputDomainEvaluation(casePath: string, out: string) {
  const bytes = await readFile(casePath), cases = CasesSchema.parse(JSON.parse(bytes.toString("utf8")));
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length, "Duplicate case ID");
  await mkdir(out); // Never replace a prior evaluation.
  const inputs = cases.map(c => { const r = resolution(c); return { id: c.id, resolution: r, profile: c.apiProfile, input: planModelInput(r, c.apiProfile) }; });
  const outgoing = JSON.stringify(inputs.map(c => ({ id: c.id, input: c.input })), null, 2) + "\n";
  await writeFile(join(out, "cases.json"), bytes, { flag: "wx" });
  await writeFile(join(out, "prepared.json"), JSON.stringify(inputs, null, 2) + "\n", { flag: "wx" });
  await writeFile(join(out, "outgoing-inputs.json"), outgoing, { flag: "wx" });
  await writeFile(join(out, "manifest.json"), JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(),
    casesSha256: sha256(bytes), preparedSha256: sha256(JSON.stringify(inputs)), outgoingSha256: sha256(outgoing),
    meaning: "Synthetic requirements and oracle frozen before API calls; oracle never sent to planner. Planning only; no project execution." }, null, 2) + "\n", { flag: "wx" });
  return { out, cases: cases.length, modelCalls: 0 };
}

export async function runInputDomainEvaluation(out: string) {
  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  const bytes = await readFile(join(out, "cases.json")), cases = CasesSchema.parse(JSON.parse(bytes.toString("utf8")));
  const inputs = JSON.parse(await readFile(join(out, "prepared.json"), "utf8")) as { id: string; resolution: Resolution; profile: z.infer<typeof ApiProfileSchema>; input: unknown }[];
  assert.equal(sha256(bytes), manifest.casesSha256); assert.equal(sha256(JSON.stringify(inputs)), manifest.preparedSha256);
  assert.equal(sha256(await readFile(join(out, "outgoing-inputs.json"))), manifest.outgoingSha256);
  assert.deepEqual(JSON.parse(await readFile(join(out, "outgoing-inputs.json"), "utf8")), inputs.map(c => ({ id: c.id, input: c.input })));
  assert.equal(inputs.length, cases.length);
  await writeFile(join(out, "run-start.json"), JSON.stringify({ startedAt: new Date().toISOString(), maxResponses: cases.length * 2 }) + "\n", { flag: "wx" });
  const model = selectModel("deepseek", undefined), gateway = new PiPlanGateway(model.piProvider, model.modelId, join(out, "data"));
  const results = [];
  for (const [i, entry] of inputs.entries()) {
    const sample = cases[i]!; assert.equal(entry.id, sample.id);
    assert.deepEqual(entry.input, planModelInput(entry.resolution, entry.profile));
    assert.deepEqual(entry.profile, sample.apiProfile);
    assert.deepEqual(entry.resolution.revisions.map(r => ({ id: r.requirementId, text: r.normalized })), sample.requirements);
    const failures: string[] = []; let generation;
    try {
      generation = await gateway.propose(entry.resolution, entry.profile);
      const plan = freezePlan(entry.resolution, generation.proposal, "model-proposal");
      await writeFile(join(out, `${entry.id}-plan.json`), JSON.stringify({ plan, generation }, null, 2) + "\n", { flag: "wx" });
      const steps = plan.criteria.flatMap(c => c.checks.flatMap(check => check.type === "http_sequence" ? check.steps : []));
      for (const [id, wanted] of Object.entries(sample.expected.coverage)) if (plan.coverage.find(c => c.requirementId === id)?.status !== wanted) failures.push(`Coverage ${id} != ${wanted}`);
      for (const wanted of sample.expected.steps) if (!steps.some(step => JSON.stringify(step.body) === JSON.stringify(wanted.body) && step.expectedStatus === wanted.status &&
        step.assertions.some(a => a.pointer === wanted.pointer && JSON.stringify(a.equals) === JSON.stringify(wanted.equals)))) failures.push(`Missing expected observation: ${JSON.stringify(wanted)}`);
      if (sample.expected.rejectedFraction) {
        const wanted = sample.expected.rejectedFraction;
        if (!steps.some(step => { const value = (step.body as Record<string, unknown> | undefined)?.[wanted.field];
          return typeof value === "number" && !Number.isInteger(value) && step.expectedStatus === wanted.status &&
            step.assertions.some(a => a.pointer === wanted.pointer && JSON.stringify(a.equals) === JSON.stringify(wanted.equals));
        })) failures.push("Missing explicitly required fractional-number rejection");
      }
      if (sample.expected.inputDomainOnly) {
        const domain = sample.expected.inputDomainOnly;
        for (const step of steps) {
          const value = (step.body as Record<string, unknown> | undefined)?.[domain.field];
          if (domain.type === "integer" ? !Number.isInteger(value) : typeof value !== "string") failures.push(`Unrequested out-of-domain input: ${JSON.stringify(step.body)}`);
          if (step.expectedStatus >= 400) failures.push("Unrequested rejection behavior");
        }
      }
      results.push({ id: entry.id, failures, coverage: plan.coverage, modelCalls: generation.modelCalls, usage: generation.usage });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      results.push({ id: entry.id, failures, modelCalls: generation?.modelCalls, usage: generation?.usage });
    }
    console.log(JSON.stringify(results.at(-1)));
  }
  // Failed candidates still consume tokens; account from all raw receipts, not only returned valid plans.
  const attemptFiles = await readdir(join(out, "data", "planner-attempts")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const attempts = await Promise.all(attemptFiles.filter(n => n.endsWith(".json")).map(async filename => {
    const receipt = JSON.parse(await readFile(join(out, "data", "planner-attempts", filename), "utf8"));
    return { filename, inputSha256: receipt.inputSha256, promptHash: receipt.promptHash, attempt: receipt.attempt, usage: receipt.usage };
  }));
  const usage = attempts.reduce((total, a) => ({ inputTokens: total.inputTokens + a.usage.input + a.usage.cacheRead + a.usage.cacheWrite,
    outputTokens: total.outputTokens + a.usage.output, estimatedCostUsd: total.estimatedCostUsd + a.usage.cost.total }), { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
  const summary = { completedAt: new Date().toISOString(), casesSha256: manifest.casesSha256, results, modelResponses: attempts.length, usage, rawAttempts: attempts,
    failures: results.flatMap(r => r.failures.map(f => `${r.id}: ${f}`)),
    meaning: "Real Flash planning, developer-authored paired samples; no functional run, user extraction proof or overall accuracy claim. Raw failed attempts remain in data/planner-attempts." };
  await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  return summary;
}

async function main() {
  const [mode, input, output] = process.argv.slice(2);
  if (mode === "prepare" && input && output) console.log(JSON.stringify(await prepareInputDomainEvaluation(resolve(input), resolve(output))));
  else if (mode === "run" && input && process.argv.includes("--allow-model")) { const r = await runInputDomainEvaluation(resolve(input)); process.exitCode = r.failures.length ? 2 : 0; }
  else throw new Error("Use prepare CASE_FILE NEW_OUTPUT_DIR, or run OUTPUT_DIR --allow-model");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
