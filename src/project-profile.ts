import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { sha256 } from "./storage.js";

export const ProjectRelativePath = z.string().min(1).max(1024).refine(value =>
  !/[\\:\x00-\x1f]/u.test(value) && !value.startsWith("/") && value.split("/").every(part =>
    part && part !== "." && part !== ".." && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
"Use a portable project-relative path without traversal or Windows aliases");
export const ProjectHash = z.string().regex(/^[a-f0-9]{64}$/);

/** Describes how to run a project, never what a particular business task should return. */
export const ProjectProfileSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  description: z.string().min(1).max(2000),
  projectRoot: z.string().min(1).refine(value => isAbsolute(value) && !value.startsWith("\\\\") && !value.startsWith("//") && resolve(value) !== parse(resolve(value)).root,
    "Choose an absolute local project directory, not a drive root or network share"),
  excludePaths: z.array(ProjectRelativePath).max(100).default([]),
  runtime: z.object({
    kind: z.literal("docker"),
    image: z.string().min(1).max(240).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/),
    command: z.array(z.string().min(1).max(2000).refine(value => !/[\x00\r\n]/.test(value))).min(1).max(32),
    containerPort: z.number().int().min(1024).max(65535),
    readiness: z.object({
      path: z.string().min(1).max(1024).refine(value => value.startsWith("/") && !value.startsWith("//") && !/[\\\x00-\x20#]/.test(value)),
      expectedStatus: z.number().int().min(200).max(399).default(200),
      timeoutMs: z.number().int().min(1000).max(120000).default(30000),
    }).strict(),
  }).strict(),
  limits: z.object({
    maxEntries: z.number().int().min(1).max(20000).default(5000),
    maxFileBytes: z.number().int().min(1).max(128 * 1024 * 1024).default(16 * 1024 * 1024),
    maxTotalBytes: z.number().int().min(1).max(512 * 1024 * 1024).default(128 * 1024 * 1024),
    maxDepth: z.number().int().min(1).max(64).default(32),
  }).strict().prefault({}),
}).strict();
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;

export async function readProjectProfile(path: string): Promise<ProjectProfile> {
  const bytes = await readFile(path);
  if (bytes.length > 512 * 1024) throw new Error("Project profile exceeds 512 KiB");
  return ProjectProfileSchema.parse(JSON.parse(bytes.toString("utf8")));
}
export function projectProfileHash(profile: ProjectProfile): string { return sha256(JSON.stringify(ProjectProfileSchema.parse(profile))); }

function inside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return !path || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
export function assertProjectStorageSeparated(dataDir: string, profile: ProjectProfile): void {
  if (inside(profile.projectRoot, dataDir) || inside(dataDir, profile.projectRoot)) throw new Error("Project and VibeGuard data directories must not overlap");
}
export async function saveProjectProfile(dataDir: string, profile: ProjectProfile): Promise<string> {
  const normalized = ProjectProfileSchema.parse(profile), digest = projectProfileHash(normalized);
  const directory = join(dataDir, "project-profiles");
  await mkdir(directory, { recursive: true });
  try { await writeFile(join(directory, `${digest}.json`), JSON.stringify(normalized, null, 2) + "\n", { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await readStoredProjectProfile(dataDir, digest);
  }
  return digest;
}
export async function readStoredProjectProfile(dataDir: string, digest: string): Promise<ProjectProfile> {
  ProjectHash.parse(digest);
  const profile = await readProjectProfile(join(dataDir, "project-profiles", `${digest}.json`));
  if (projectProfileHash(profile) !== digest) throw new Error("Stored project profile hash mismatch");
  return profile;
}
