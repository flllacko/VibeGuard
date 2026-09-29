import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FrozenPlan } from "./planning.js";
import type { PlanGatewayOutput } from "./pi-plan-gateway.js";

export interface PlanRecord {
  plan: FrozenPlan;
  generation: { model: string; promptHash: string; usage: PlanGatewayOutput["usage"]; profileId: string };
}

export async function savePlanRecord(dataDir: string, record: PlanRecord): Promise<string> {
  const directory = join(dataDir, "plans");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${record.plan.planHash}.json`);
  try {
    await writeFile(path, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = JSON.parse(await readFile(path, "utf8")) as PlanRecord;
    if (existing.plan.planHash !== record.plan.planHash) throw new Error("Existing plan hash mismatch");
  }
  return path;
}

export async function readPlanRecord(dataDir: string, planHash: string): Promise<PlanRecord> {
  if (!/^[0-9a-f]{64}$/.test(planHash)) throw new Error("Invalid plan hash");
  return JSON.parse(await readFile(join(dataDir, "plans", `${planHash}.json`), "utf8")) as PlanRecord;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
