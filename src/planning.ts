import { z } from "zod";
import { sha256 } from "./storage.js";
import { currentRequirements, type Resolution } from "./requirements.js";
import { FileCheckSchema } from "./file-profile.js";

const Identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);

const JsonAssertionSchema = z.object({
  pointer: z.string().regex(/^(?:\/(?:[^/~]|~[01])*)*$/),
  equals: z.unknown(),
}).strict();

const HttpStepSchema = z.object({
  stepId: Identifier,
  method: z.enum(["GET", "POST"]),
  pathTemplate: z.string().min(1),
  body: z.unknown().optional(),
  expectedStatus: z.number().int().min(100).max(599),
  assertions: z.array(JsonAssertionSchema).max(20).default([]),
  captures: z.array(z.object({ name: Identifier, pointer: z.string().regex(/^(?:\/(?:[^/~]|~[01])*)*$/) }).strict()).max(10).default([]),
}).strict();

const CheckSpecSchema = z.object({
  checkId: Identifier,
  type: z.literal("http_sequence"),
  purpose: z.string().min(1),
  timeoutMs: z.number().int().min(100).max(60000),
  steps: z.array(HttpStepSchema).min(1).max(20),
}).strict();

export const PlanProposalSchema = z.object({
  criteria: z.array(z.object({
    criterionId: Identifier,
    requirementIds: z.array(Identifier).min(1),
    sourceKind: z.enum(["explicit_user", "derived_check"]),
    description: z.string().min(1),
    preconditions: z.array(z.string().min(1)),
    expected: z.string().min(1),
    checks: z.array(z.union([CheckSpecSchema, FileCheckSchema])).min(1).max(100),
  }).strict()).max(100),
  coverage: z.array(z.object({
    requirementId: Identifier,
    criterionIds: z.array(Identifier),
    status: z.enum(["planned", "partial", "unverifiable"]),
    gapReason: z.string().min(1).optional(),
  }).strict()).max(100),
}).strict();

export type PlanProposal = z.infer<typeof PlanProposalSchema>;
export type HttpCheckSpec = z.infer<typeof CheckSpecSchema>;
export interface HttpPlanProposal extends Omit<PlanProposal, "criteria"> {
  criteria: Array<Omit<PlanProposal["criteria"][number], "checks"> & { checks: HttpCheckSpec[] }>;
}

export interface FrozenPlan extends PlanProposal {
  schemaVersion: 1;
  planHash: string;
  resolutionId: string;
  conversationSha256: string;
  requirementSnapshotHash: string;
  source: "model-proposal" | "manual-fixture";
}
export interface FrozenHttpPlan extends Omit<FrozenPlan, "criteria"> { criteria: HttpPlanProposal["criteria"] }

export function freezePlan(resolution: Resolution, candidate: HttpPlanProposal, source: FrozenPlan["source"]): FrozenHttpPlan;
export function freezePlan(resolution: Resolution, candidate: unknown, source: FrozenPlan["source"]): FrozenPlan;
export function freezePlan(resolution: Resolution, candidate: unknown, source: FrozenPlan["source"]): FrozenPlan {
  if (!resolution.resolutionComplete) throw new Error("Cannot plan against incomplete or unresolved conversation material");
  const active = currentRequirements(resolution.revisions);
  if (active.length === 0) throw new Error("No active user requirements to plan");
  const proposal = PlanProposalSchema.parse(candidate);
  const activeIds = new Set(active.map(item => item.requirementId));
  const criteria = new Map<string, PlanProposal["criteria"][number]>();
  const checkIds = new Set<string>();
  for (const criterion of proposal.criteria) {
    if (criteria.has(criterion.criterionId)) throw new Error(`Duplicate criterion ID: ${criterion.criterionId}`);
    criteria.set(criterion.criterionId, criterion);
    if (new Set(criterion.requirementIds).size !== criterion.requirementIds.length) throw new Error(`Duplicate requirement link in ${criterion.criterionId}`);
    for (const id of criterion.requirementIds) if (!activeIds.has(id)) throw new Error(`Criterion ${criterion.criterionId} links inactive or unknown requirement ${id}`);
    for (const check of criterion.checks) {
      if (checkIds.has(check.checkId)) throw new Error(`Duplicate check ID: ${check.checkId}`);
      checkIds.add(check.checkId);
      if (check.type !== "http_sequence") continue;
      const stepIds = new Set<string>();
      const availableCaptures = new Set<string>();
      for (const step of check.steps) {
        if (stepIds.has(step.stepId)) throw new Error(`Duplicate step ID in ${check.checkId}: ${step.stepId}`);
        stepIds.add(step.stepId);
        validatePathTemplate(step.pathTemplate, availableCaptures);
        for (const capture of step.captures) {
          if (availableCaptures.has(capture.name)) throw new Error(`Duplicate capture ${capture.name} in ${check.checkId}`);
          availableCaptures.add(capture.name);
        }
      }
    }
  }
  const coverage = new Map<string, PlanProposal["coverage"][number]>();
  for (const row of proposal.coverage) {
    if (!activeIds.has(row.requirementId)) throw new Error(`Coverage references inactive or unknown requirement ${row.requirementId}`);
    if (coverage.has(row.requirementId)) throw new Error(`Duplicate coverage row for ${row.requirementId}`);
    coverage.set(row.requirementId, row);
    if (new Set(row.criterionIds).size !== row.criterionIds.length) throw new Error(`Duplicate criterion link for ${row.requirementId}`);
    if (row.status === "planned" && (row.criterionIds.length === 0 || row.gapReason)) throw new Error(`Planned requirement ${row.requirementId} needs checks and no gap`);
    if (row.status === "partial" && (row.criterionIds.length === 0 || !row.gapReason)) throw new Error(`Partial requirement ${row.requirementId} needs checks and a gap reason`);
    if (row.status === "unverifiable" && (row.criterionIds.length !== 0 || !row.gapReason)) throw new Error(`Unverifiable requirement ${row.requirementId} needs a reason and no check`);
    for (const criterionId of row.criterionIds) {
      const criterion = criteria.get(criterionId);
      if (!criterion) throw new Error(`Coverage references missing criterion ${criterionId}`);
      if (!criterion.requirementIds.includes(row.requirementId)) throw new Error(`Coverage and criterion disagree for ${row.requirementId}`);
    }
  }
  for (const id of activeIds) if (!coverage.has(id)) throw new Error(`Active requirement ${id} has no planning destination`);
  for (const criterion of criteria.values()) {
    for (const id of criterion.requirementIds) {
      if (!coverage.get(id)?.criterionIds.includes(criterion.criterionId)) throw new Error(`Criterion ${criterion.criterionId} is not linked back from ${id}`);
    }
  }
  const requirementSnapshotHash = sha256(JSON.stringify(active));
  const planHash = sha256(JSON.stringify({ resolutionId: resolution.resolutionId, requirementSnapshotHash, proposal }));
  return {
    schemaVersion: 1,
    planHash,
    resolutionId: resolution.resolutionId,
    conversationSha256: resolution.conversationSha256,
    requirementSnapshotHash,
    source,
    ...proposal,
  };
}

export function assertPlanRoutes(plan: Pick<FrozenPlan, "criteria">, allowedRoutes: ReadonlySet<string>): void {
  const allowedShapes = new Set([...allowedRoutes].map(routeShape));
  for (const criterion of plan.criteria) for (const check of criterion.checks) {
    if (check.type !== "http_sequence") throw new Error("HTTP profile cannot authorize file checks");
    for (const step of check.steps) {
      const route = `${step.method} ${step.pathTemplate}`;
      if (!allowedShapes.has(routeShape(route))) throw new Error(`HTTP route is outside the authorized profile: ${route}`);
    }
  }
}

function routeShape(route: string): string {
  return route.replace(/\{[A-Za-z][A-Za-z0-9_-]*\}/g, "{}");
}

function validatePathTemplate(path: string, captures: Set<string>): void {
  if (!/^\/[A-Za-z0-9/_{}-]*$/.test(path) || path.includes("//") || path.includes("..")) {
    throw new Error(`HTTP path must be a safe relative path: ${path}`);
  }
  for (const match of path.matchAll(/\{([^{}]+)\}/g)) {
    const name = match[1]!;
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) || !captures.has(name)) throw new Error(`HTTP path uses unknown capture ${name}`);
  }
  if (path.replace(/\{[A-Za-z][A-Za-z0-9_-]*\}/g, "").includes("{") || path.replace(/\{[A-Za-z][A-Za-z0-9_-]*\}/g, "").includes("}")) {
    throw new Error(`Invalid HTTP path template: ${path}`);
  }
}
