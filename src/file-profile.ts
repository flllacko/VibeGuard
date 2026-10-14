import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { FrozenPlan } from "./planning.js";
import { sha256 } from "./storage.js";

const Identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const RelativePath = z.string().max(1024).refine(value => value === "" || (
  !/[\\:\0]/u.test(value) && !value.startsWith("/") && value.split("/").every(part => part && part !== "." && part !== "..")
), "File path must stay relative to its authorized root; use an empty path for the root");
export const FileRefSchema = z.object({ rootId: Identifier, path: RelativePath }).strict();
export const FileCheckSchema = z.discriminatedUnion("type", [
  z.object({ checkId: Identifier, type: z.literal("entry_exists"), purpose: z.string().min(1), target: FileRefSchema, expectedKind: z.enum(["file", "directory"]) }).strict(),
  z.object({ checkId: Identifier, type: z.literal("tree_compare"), purpose: z.string().min(1), reference: FileRefSchema, target: FileRefSchema, comparison: z.enum(["structure", "content"]) }).strict(),
]);
export type FileCheck = z.infer<typeof FileCheckSchema>;
export type FileRef = z.infer<typeof FileRefSchema>;

export const FileProfileSchema = z.object({
  schemaVersion: z.literal(1), profileId: Identifier, description: z.string().min(1),
  roots: z.array(z.object({
    rootId: Identifier, role: z.enum(["reference", "delivery"]), description: z.string().min(1),
    path: z.string().min(1).refine(value => isAbsolute(value) && !value.startsWith("\\\\") && !value.startsWith("//"), "Only absolute local roots are supported"),
  }).strict()).min(1).max(8),
  limits: z.object({
    maxEntries: z.number().int().min(1).max(20000).default(5000),
    maxFileBytes: z.number().int().min(1).max(128 * 1024 * 1024).default(32 * 1024 * 1024),
    maxTotalBytes: z.number().int().min(1).max(1024 * 1024 * 1024).default(128 * 1024 * 1024),
    maxDepth: z.number().int().min(1).max(64).default(32),
  }).strict().prefault({}),
}).strict().superRefine((profile, context) => {
  const ids = profile.roots.map(root => root.rootId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Duplicate file root ID" });
});
export type FileProfile = z.infer<typeof FileProfileSchema>;

export async function readFileProfile(path: string): Promise<FileProfile> {
  const bytes = await readFile(path);
  if (bytes.byteLength > 512 * 1024) throw new Error("File profile exceeds 512 KiB");
  return FileProfileSchema.parse(JSON.parse(bytes.toString("utf8")));
}
export function fileProfileHash(profile: FileProfile): string { return sha256(JSON.stringify(profile)); }

export function assertFilePlanMatchesProfile(plan: Pick<FrozenPlan, "criteria">, profile: FileProfile): void {
  for (const criterion of plan.criteria) for (const candidate of criterion.checks) {
    const check = FileCheckSchema.parse(candidate);
    const target = profile.roots.find(root => root.rootId === check.target.rootId);
    if (!target || target.role !== "delivery") throw new Error(`Check ${check.checkId} target is not an authorized delivery root`);
    if (check.type === "tree_compare") {
      const reference = profile.roots.find(root => root.rootId === check.reference.rootId);
      if (!reference || reference.role !== "reference") throw new Error(`Check ${check.checkId} needs an authorized reference root`);
      const left = resolve(reference.path, check.reference.path);
      const right = resolve(target.path, check.target.path);
      if ((process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right)) throw new Error("Cannot compare a delivery with itself");
    }
  }
}

export function assertEvidenceOutsideRoots(dataDir: string, profile: FileProfile): void {
  for (const root of profile.roots) {
    const difference = relative(resolve(root.path), resolve(dataDir));
    if (!difference || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference))) throw new Error("Evidence directory must be outside inspected roots");
  }
}

export async function saveFileProfile(dataDir: string, profile: FileProfile): Promise<string> {
  const hash = fileProfileHash(profile);
  const directory = join(dataDir, "file-profiles");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${hash}.json`);
  try { await writeFile(path, JSON.stringify(profile, null, 2) + "\n", { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (fileProfileHash(await readFileProfile(path)) !== hash) throw new Error("Stored file profile hash mismatch");
  }
  return hash;
}
export async function readStoredFileProfile(dataDir: string, hash: string): Promise<FileProfile> {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid file profile hash");
  const profile = await readFileProfile(join(dataDir, "file-profiles", `${hash}.json`));
  if (fileProfileHash(profile) !== hash) throw new Error("Stored file profile hash mismatch");
  return profile;
}
