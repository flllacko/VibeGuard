import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readExternalProject } from "./external-project.js";
import { ApiProfileSchema, planModelInput, type ApiProfile, type PlanGatewayOutput } from "./pi-plan-gateway.js";
import { assertPlanMatchesProfile, profileHash } from "./plan-profile.js";
import { buildAcceptancePlan, renderAcceptancePlan } from "./plan-review.js";
import { freezePlan, PlanProposalSchema } from "./planning.js";
import { ProjectHash } from "./project-profile.js";
import { readResolution } from "./resolution-storage.js";
import type { Resolution } from "./requirements.js";
import { sha256 } from "./storage.js";
import { readTask } from "./task-registry.js";
import { readTaskIntake } from "./task-scope.js";

export interface ExternalPlanGateway {
  propose(resolution: Resolution, profile: ApiProfile): Promise<PlanGatewayOutput>;
}
const FrozenPlanSchema = PlanProposalSchema.extend({
  schemaVersion: z.literal(1), planHash: ProjectHash, resolutionId: z.string().uuid(),
  conversationSha256: ProjectHash, requirementSnapshotHash: ProjectHash,
  source: z.enum(["model-proposal", "manual-fixture"]),
}).strict();
const RecordSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("external-http-plan"), planRef: z.string().uuid(), createdAt: z.string().datetime(),
  projectRef: z.string().uuid(), projectRecordHash: ProjectHash, targetSnapshotHash: ProjectHash,
  reviewRef: z.string().uuid(), reviewHash: ProjectHash, requirementsSha256: ProjectHash,
  checkedConversationSha256: ProjectHash, runtimeProfileSha256: ProjectHash,
  apiProfileSha256: ProjectHash, apiProfile: ApiProfileSchema, plan: FrozenPlanSchema,
  generation: z.object({ model: z.string().min(1), promptHash: ProjectHash,
    usage: z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), estimatedCostUsd: z.number().nonnegative() }).strict(),
  }).strict(),
  recordHash: ProjectHash,
}).strict();
export type ExternalPlanRecord = z.infer<typeof RecordSchema>;
const digest = ({ recordHash: ignored, ...body }: ExternalPlanRecord) => { void ignored; return sha256(JSON.stringify(body)); };
function recordPath(dataDir: string, planRef: string) {
  z.string().uuid().parse(planRef); return join(dataDir, "external-plans", `${planRef}.json`);
}

/** A projection of the reviewed version, never a new extraction or an edit to the original resolution. */
async function planningMaterial(dataDir: string, projectRef: string) {
  const bound = await readExternalProject(dataDir, projectRef);
  const current = await readTaskIntake(dataDir, await readTask(dataDir, bound.project.currentTaskRef));
  const original = await readResolution(bound.requirements.resolutionId, dataDir);
  const resolution: Resolution = {
    schemaVersion: 1, resolutionId: bound.project.reviewRef, taskId: original.taskId, createdAt: bound.project.createdAt,
    conversationSha256: bound.project.checkedConversationSha256, transcriptCoverage: current.conversation.transcriptCoverage,
    coverageIssues: [], revisions: bound.requirements.requirements.map(item => ({
      requirementId: item.requirementId, revision: 1, status: "active", normalized: item.normalized,
      sourceKind: original.revisions.findLast(revision => revision.requirementId === item.requirementId)?.sourceKind ?? "explicit_user",
      sourceRefs: structuredClone(item.sourceRefs),
    })), dispositions: [], processing: [], unprocessedUserMessageIds: [], resolutionComplete: true,
  };
  return { ...bound, resolution };
}

/** Exact minimal model payload: reviewed requirements plus API contract, not the full chat or source tree. */
export async function externalPlanInput(dataDir: string, projectRef: string, apiProfile: ApiProfile) {
  const { project, resolution } = await planningMaterial(dataDir, projectRef);
  const profile = ApiProfileSchema.parse(apiProfile);
  return { projectRef, reviewRef: project.reviewRef, targetSnapshotHash: project.targetSnapshotHash,
    apiProfileSha256: profileHash(profile), status: "planning_input_only", modelInput: planModelInput(resolution, profile),
    meaning: "仅预览待送规划模型的材料；没有调用模型、运行项目或得出验收结论。" };
}

export async function createExternalPlan(dataDir: string, projectRef: string, apiProfile: ApiProfile, gateway: ExternalPlanGateway): Promise<ExternalPlanRecord> {
  const { project, resolution } = await planningMaterial(dataDir, projectRef), profile = ApiProfileSchema.parse(apiProfile);
  const generation = await gateway.propose(structuredClone(resolution), structuredClone(profile));
  const plan = freezePlan(resolution, generation.proposal, "model-proposal");
  assertPlanMatchesProfile(plan, profile);
  // A concurrent review change or changed delivery invalidates the proposal before publication.
  const checked = await planningMaterial(dataDir, projectRef);
  if (checked.project.recordHash !== project.recordHash || JSON.stringify(checked.resolution) !== JSON.stringify(resolution)) throw new Error("External planning material changed during generation");
  const candidate = RecordSchema.parse({ schemaVersion: 1, kind: "external-http-plan", planRef: randomUUID(), createdAt: new Date().toISOString(),
    projectRef, projectRecordHash: project.recordHash, targetSnapshotHash: project.targetSnapshotHash,
    reviewRef: project.reviewRef, reviewHash: project.reviewHash, requirementsSha256: project.requirementsSha256,
    checkedConversationSha256: project.checkedConversationSha256, runtimeProfileSha256: project.profileSha256,
    apiProfileSha256: profileHash(profile), apiProfile: profile, plan,
    generation: { model: generation.model, promptHash: generation.promptHash, usage: generation.usage }, recordHash: "0".repeat(64) });
  candidate.recordHash = digest(candidate);
  await mkdir(join(dataDir, "external-plans"), { recursive: true });
  await writeFile(recordPath(dataDir, candidate.planRef), JSON.stringify(candidate, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return candidate;
}

export async function readExternalPlan(dataDir: string, planRef: string) {
  const bytes = await readFile(recordPath(dataDir, planRef));
  if (bytes.length > 8 * 1024 * 1024) throw new Error("External plan exceeds 8 MiB");
  const record = RecordSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (record.planRef !== planRef || digest(record) !== record.recordHash || profileHash(record.apiProfile) !== record.apiProfileSha256) throw new Error("External plan record integrity mismatch");
  const { project, resolution } = await planningMaterial(dataDir, record.projectRef);
  if (project.recordHash !== record.projectRecordHash || project.targetSnapshotHash !== record.targetSnapshotHash ||
    project.reviewRef !== record.reviewRef || project.reviewHash !== record.reviewHash || project.requirementsSha256 !== record.requirementsSha256 ||
    project.checkedConversationSha256 !== record.checkedConversationSha256 || project.profileSha256 !== record.runtimeProfileSha256) throw new Error("External plan binding mismatch");
  const frozen = freezePlan(resolution, { criteria: record.plan.criteria, coverage: record.plan.coverage }, record.plan.source);
  if (JSON.stringify(FrozenPlanSchema.parse(frozen)) !== JSON.stringify(record.plan)) throw new Error("External plan no longer matches the reviewed requirements");
  assertPlanMatchesProfile(frozen, record.apiProfile);
  return { record, resolution };
}

export async function externalPlanView(dataDir: string, planRef: string) {
  const { record, resolution } = await readExternalPlan(dataDir, planRef);
  const acceptance = buildAcceptancePlan(record.plan, resolution);
  return { planRef, projectRef: record.projectRef, targetSnapshotHash: record.targetSnapshotHash,
    reviewRef: record.reviewRef, status: "planned_not_executed", verdict: "UNVERIFIABLE", evidence: [],
    coverage: { totalRequirements: record.plan.coverage.length,
      planned: record.plan.coverage.filter(item => item.status === "planned").length,
      partial: record.plan.coverage.filter(item => item.status === "partial").length,
      unverifiable: record.plan.coverage.filter(item => item.status === "unverifiable").length,
      meaning: "仅为计划覆盖账目，不是已验证数量、置信度或语义完整性保证。" },
    acceptance, text: renderAcceptancePlan(acceptance),
    missingEvidence: ["计划尚未接入 Docker 中的功能检查", "各项标准的实际执行观察"],
    meaning: "要求原话、标准与执行步骤已关联；尚未执行，不是验收通过，也不授权执行任意 API。" };
}
