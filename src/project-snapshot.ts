import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, parse, resolve, sep } from "node:path";
import { z } from "zod";
import { assertProjectStorageSeparated, ProjectHash, ProjectRelativePath, projectProfileHash, type ProjectProfile } from "./project-profile.js";
import { sha256 } from "./storage.js";

const EntrySchema = z.object({ path: ProjectRelativePath, kind: z.enum(["file", "directory"]), bytes: z.number().int().nonnegative().optional(), sha256: ProjectHash.optional() }).strict();
const SnapshotSchema = z.object({
  schemaVersion: z.literal(1), snapshotRef: z.string().uuid(), profileSha256: ProjectHash,
  sourceRoot: z.string(), capturedAt: z.string().datetime(),
  entries: z.array(EntrySchema).min(1).max(20000),
  excluded: z.array(z.object({ path: ProjectRelativePath, reason: z.enum(["dependency_or_tool_data", "local_secret_filename", "profile_exclusion"]) }).strict()).max(20000),
  snapshotHash: ProjectHash, kind: z.literal("project-copy-not-executed"),
}).strict();
export type ProjectSnapshot = z.infer<typeof SnapshotSchema>;
type Entry = ProjectSnapshot["entries"][number];
type Scan = { entries: Entry[]; excluded: ProjectSnapshot["excluded"]; identities: Map<string, string> };
const byPath = (left: { path: string }, right: { path: string }) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
const stamp = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");

async function noLinks(path: string): Promise<void> {
  const absolute = resolve(path), base = parse(absolute).root;
  let current = base;
  for (const part of absolute.slice(base.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Project snapshots do not follow symbolic links or junctions");
  }
}
function exclusion(path: string, profile: ProjectProfile): ProjectSnapshot["excluded"][number]["reason"] | undefined {
  const name = path.split("/").at(-1)!.toLowerCase();
  if ([".git", "node_modules", ".vibeguard"].includes(name)) return "dependency_or_tool_data";
  if (name === ".env" || name.startsWith(".env.") || /\.(?:pem|key|pfx|p12)$/.test(name) || /^id_(?:rsa|ed25519)(?:\.|$)/.test(name)) return "local_secret_filename";
  const normalized = process.platform === "win32" ? path.toLowerCase() : path;
  if (profile.excludePaths.some(item => {
    const target = process.platform === "win32" ? item.toLowerCase() : item;
    return normalized === target || normalized.startsWith(`${target}/`);
  })) return "profile_exclusion";
  return undefined;
}

/** Copies only allowlisted-by-inventory local entries. No project command or Git hook is run. */
async function scan(root: string, profile: ProjectProfile, destination?: string, filter = true): Promise<Scan> {
  const entries: Entry[] = [], excluded: Scan["excluded"] = [], identities = new Map<string, string>(), aliases = new Set<string>();
  let count = 0, total = 0;
  await noLinks(root);
  if (!(await lstat(root)).isDirectory()) throw new Error("Project root is not a directory");
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > profile.limits.maxDepth) throw new Error("Project exceeds snapshot depth limit");
    const path = relative ? join(root, relative) : root;
    await noLinks(path);
    const before = await lstat(path, { bigint: true });
    identities.set(relative, stamp(before));
    if (before.isDirectory()) {
      if (relative) {
        entries.push({ path: relative, kind: "directory" });
        if (destination) await mkdir(join(destination, relative));
      }
      for (const name of (await readdir(path)).sort()) {
        if (++count > profile.limits.maxEntries) throw new Error("Project exceeds snapshot entry limit");
        const child = relative ? `${relative}/${name}` : name;
        ProjectRelativePath.parse(child);
        if (aliases.has(child.toLowerCase())) throw new Error("Project contains case-ambiguous paths");
        aliases.add(child.toLowerCase());
        const reason = filter ? exclusion(child, profile) : undefined;
        if (reason) { excluded.push({ path: child, reason }); continue; }
        await walk(child, depth + 1);
      }
    } else if (before.isFile()) {
      if (before.size > BigInt(profile.limits.maxFileBytes)) throw new Error("Project file exceeds snapshot byte limit");
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let output: Awaited<ReturnType<typeof open>> | undefined;
      try {
        if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) throw new Error("Project file changed before copying");
        if (destination) output = await open(join(destination, relative), "wx", 0o600);
        const digest = createHash("sha256"); let bytes = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          bytes += chunk.length; total += chunk.length;
          if (bytes > profile.limits.maxFileBytes || total > profile.limits.maxTotalBytes) throw new Error("Project exceeds snapshot byte limit");
          digest.update(chunk);
          if (output) await output.writeFile(chunk);
        }
        if (BigInt(bytes) !== before.size || stamp(await handle.stat({ bigint: true })) !== stamp(before)) throw new Error("Project file changed while copying");
        entries.push({ path: relative, kind: "file", bytes, sha256: digest.digest("hex") });
      } finally { await output?.close(); await handle.close(); }
    } else throw new Error("Project contains unsupported special entries");
    await noLinks(path);
    if (stamp(await lstat(path, { bigint: true })) !== stamp(before)) throw new Error("Project tree changed during capture");
  };
  await walk("", 0);
  return { entries: entries.sort(byPath), excluded: excluded.sort(byPath), identities };
}
function digest(snapshot: Omit<ProjectSnapshot, "snapshotHash">): string {
  return sha256(JSON.stringify({ schemaVersion: snapshot.schemaVersion, profileSha256: snapshot.profileSha256, sourceRoot: snapshot.sourceRoot, entries: snapshot.entries, excluded: snapshot.excluded, kind: snapshot.kind }));
}
export function projectSnapshotDirectory(dataDir: string, snapshotRef: string): string {
  z.string().uuid().parse(snapshotRef);
  return join(dataDir, "project-snapshots", snapshotRef);
}
export async function captureProjectSnapshot(dataDir: string, profile: ProjectProfile): Promise<ProjectSnapshot> {
  assertProjectStorageSeparated(dataDir, profile);
  await noLinks(resolve(dataDir));
  const snapshotRef = randomUUID(), directory = projectSnapshotDirectory(dataDir, snapshotRef), files = join(directory, "files");
  const snapshots = join(dataDir, "project-snapshots");
  await mkdir(snapshots, { recursive: true }); await noLinks(snapshots);
  await mkdir(directory); await mkdir(files);
  const sourceRoot = resolve(profile.projectRoot);
  const copied = await scan(sourceRoot, profile, files);
  const after = await scan(sourceRoot, profile);
  if (JSON.stringify(copied.entries) !== JSON.stringify(after.entries) || JSON.stringify(copied.excluded) !== JSON.stringify(after.excluded) ||
    JSON.stringify([...copied.identities]) !== JSON.stringify([...after.identities])) throw new Error("Project changed while its snapshot was being prepared; prepare again");
  if (!copied.entries.some(entry => entry.path === "package.json" && entry.kind === "file")) throw new Error("First external project support requires package.json");
  const body: Omit<ProjectSnapshot, "snapshotHash"> = { schemaVersion: 1, snapshotRef, sourceRoot, profileSha256: projectProfileHash(profile), capturedAt: new Date().toISOString(),
    entries: copied.entries, excluded: copied.excluded, kind: "project-copy-not-executed" };
  const manifest = SnapshotSchema.parse({ ...body, snapshotHash: digest(body) });
  // No complete manifest is published on failure. Partial directories never qualify as a snapshot.
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return readProjectSnapshot(dataDir, snapshotRef, profile);
}
export async function readProjectSnapshot(dataDir: string, snapshotRef: string, profile: ProjectProfile): Promise<ProjectSnapshot> {
  assertProjectStorageSeparated(dataDir, profile);
  const directory = projectSnapshotDirectory(dataDir, snapshotRef);
  await noLinks(directory); await noLinks(join(directory, "manifest.json"));
  if ((await lstat(join(directory, "manifest.json"))).size > 32 * 1024 * 1024) throw new Error("Project snapshot manifest exceeds 32 MiB");
  const manifest = SnapshotSchema.parse(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
  if (manifest.snapshotRef !== snapshotRef || manifest.profileSha256 !== projectProfileHash(profile) || manifest.sourceRoot !== resolve(profile.projectRoot) || digest(manifest) !== manifest.snapshotHash) throw new Error("Project snapshot manifest binding mismatch");
  for (const entry of manifest.entries) {
    if ((entry.kind === "file") !== (entry.bytes !== undefined && entry.sha256 !== undefined) || (entry.kind === "directory" && (entry.bytes !== undefined || entry.sha256 !== undefined))) throw new Error("Invalid project snapshot entry");
  }
  const actual = await scan(join(directory, "files"), profile, undefined, false);
  if (JSON.stringify(actual.entries) !== JSON.stringify(manifest.entries)) throw new Error("Project snapshot contents changed or contain unrecorded entries");
  return manifest;
}
