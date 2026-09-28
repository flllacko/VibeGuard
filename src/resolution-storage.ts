import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "./storage.js";
import type { IntakeResult } from "./intake.js";
import type { Resolution } from "./requirements.js";

export async function saveConversationCopy(intake: IntakeResult, sourcePath: string, dataDir: string): Promise<string> {
  const raw = await readFile(sourcePath);
  if (sha256(raw) !== intake.rawSha256) throw new Error("Conversation file changed while being imported");
  const directory = join(dataDir, "conversations");
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${intake.rawSha256}.json`);
  try {
    await writeFile(target, raw, { flag: "wx" });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readFile(target);
    if (sha256(existing) !== intake.rawSha256) throw new Error("Stored conversation hash mismatch");
  }
  return target;
}

export async function saveResolution(resolution: Resolution, dataDir: string): Promise<string> {
  const directory = join(dataDir, "resolutions");
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${resolution.resolutionId}.json`);
  await writeFile(target, JSON.stringify(resolution, null, 2) + "\n", { flag: "wx" });
  return target;
}

export async function readResolution(resolutionId: string, dataDir: string): Promise<Resolution> {
  if (!/^[0-9a-f-]{36}$/.test(resolutionId)) throw new Error("Invalid resolution ID");
  const source = join(dataDir, "resolutions", `${resolutionId}.json`);
  return JSON.parse(await readFile(source, "utf8")) as Resolution;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
