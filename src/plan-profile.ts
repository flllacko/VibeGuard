import type { ApiProfile } from "./pi-plan-gateway.js";
import { assertPlanRoutes, type FrozenPlan } from "./planning.js";
import { sha256 } from "./storage.js";

export function profileHash(profile: ApiProfile): string {
  return sha256(JSON.stringify(profile));
}

export function assertPlanMatchesProfile(plan: Pick<FrozenPlan, "criteria">, profile: ApiProfile): void {
  const routes = new Map<string, ApiProfile["routes"][number]>();
  for (const route of profile.routes) {
    const shape = routeShape(route.method, route.pathTemplate);
    if (routes.has(shape)) throw new Error(`Duplicate API profile route: ${shape}`);
    routes.set(shape, route);
  }
  assertPlanRoutes(plan, new Set(profile.routes.map(route => `${route.method} ${route.pathTemplate}`)));

  const isolation = new Map<string, Set<string>>();
  for (const rule of profile.isolationRules) {
    const shape = routeShape(rule.method, rule.pathTemplate);
    if (!routes.has(shape)) throw new Error(`Isolation rule references unknown route: ${shape}`);
    const fields = isolation.get(shape) ?? new Set<string>();
    fields.add(rule.bodyField);
    isolation.set(shape, fields);
  }
  const claimed = new Map<string, string>();
  for (const criterion of plan.criteria) for (const check of criterion.checks) {
    if (check.type !== "http_sequence") throw new Error("HTTP profile cannot authorize file checks");
    for (const step of check.steps) {
    const shape = routeShape(step.method, step.pathTemplate);
    const route = routes.get(shape);
    if (!route) throw new Error(`HTTP route is outside the authorized profile: ${shape}`);
    if (step.expectedStatus >= 200 && step.expectedStatus < 300 && step.expectedStatus !== route.successStatus) {
      throw new Error(`${check.checkId}/${step.stepId}: success status ${step.expectedStatus} disagrees with API profile ${route.successStatus}`);
    }
    for (const field of isolation.get(shape) ?? []) {
      const body = step.body;
      const value = typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)[field] : undefined;
      if ((typeof value !== "string" || !value) && typeof value !== "number") {
        throw new Error(`${check.checkId}/${step.stepId}: isolation field ${field} is missing or invalid`);
      }
      const key = `${shape}\u0000${field}\u0000${JSON.stringify(value)}`;
      const previous = claimed.get(key);
      if (previous && previous !== check.checkId) {
        throw new Error(`Independent checks ${previous} and ${check.checkId} reuse ${field}=${JSON.stringify(value)}`);
      }
      claimed.set(key, check.checkId);
    }
    }
  }
}

function routeShape(method: string, pathTemplate: string): string {
  return `${method} ${pathTemplate.replace(/\{[A-Za-z][A-Za-z0-9_-]*\}/g, "{}")}`;
}
