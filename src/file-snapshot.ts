import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, parse, resolve, sep } from "node:path";
import type { BigIntStats } from "node:fs";
import type { FileProfile } from "./file-profile.js";
import { fileProfileHash } from "./file-profile.js";
import { sha256 } from "./storage.js";

export interface FileEntry { path: string; kind: "file" | "directory"; bytes?: number; sha256?: string; identity: string }
export interface RootObservation {
  rootId: string; path: string; status: "present" | "missing" | "unavailable";
  entries: FileEntry[]; error?: string;
}
export interface FileSnapshot {
  profileSha256: string; snapshotHash: string; startedAt: string; capturedAt: string;
  roots: RootObservation[]; bytesRead: number;
}

function identity(stat: BigIntStats): string {
  return sha256([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":"));
}

/** Rejects symlinks/junctions in the root, its ancestors, and descendant entries. */
async function rejectLinks(path: string): Promise<void> {
  const absolute = resolve(path);
  const base = parse(absolute).root;
  let current = base;
  for (const part of absolute.slice(base.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symbolic link or junction is unsupported: ${current}`);
  }
}

export async function captureFileSnapshot(profile: FileProfile): Promise<FileSnapshot> {
  const startedAt = new Date().toISOString();
  const budget = { entries: 0, bytes: 0 };
  const roots: RootObservation[] = [];
  for (const root of [...profile.roots].sort((left, right) => left.rootId.localeCompare(right.rootId))) {
    const observation: RootObservation = { rootId: root.rootId, path: resolve(root.path), status: "present", entries: [] };
    roots.push(observation);
    try {
      try { await rejectLinks(root.path); await lstat(root.path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { observation.status = "missing"; continue; }
        throw error;
      }
      const walk = async (relativePath: string, depth: number): Promise<void> => {
        if (depth > profile.limits.maxDepth) throw new Error("File snapshot exceeds depth limit");
        if (++budget.entries > profile.limits.maxEntries) throw new Error("File snapshot exceeds entry limit");
        const path = join(root.path, relativePath);
        await rejectLinks(path);
        const before = await lstat(path, { bigint: true });
        if (before.isDirectory()) {
          observation.entries.push({ path: relativePath, kind: "directory", identity: identity(before) });
          const names = (await readdir(path)).sort();
          for (const name of names) {
            // A POSIX filename containing a backslash/colon must not become an
            // ambiguous cross-platform reference in the plan or evidence.
            if (/[\\:\0]/u.test(name)) throw new Error("Unsupported filename in inspected tree");
            await walk(relativePath ? `${relativePath}/${name}` : name, depth + 1);
          }
        } else if (before.isFile()) {
          if (before.size > BigInt(profile.limits.maxFileBytes)) throw new Error("File exceeds per-file size limit");
          const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            if (identity(await handle.stat({ bigint: true })) !== identity(before)) throw new Error("File changed before reading");
            const digest = createHash("sha256");
            let bytes = 0;
            for await (const chunk of handle.createReadStream({ autoClose: false })) {
              bytes += chunk.length;
              budget.bytes += chunk.length;
              if (bytes > profile.limits.maxFileBytes || budget.bytes > profile.limits.maxTotalBytes) throw new Error("File snapshot exceeds byte limit");
              digest.update(chunk);
            }
            if (BigInt(bytes) !== before.size || identity(await handle.stat({ bigint: true })) !== identity(before)) throw new Error("File changed while reading");
            observation.entries.push({ path: relativePath, kind: "file", bytes, sha256: digest.digest("hex"), identity: identity(before) });
          } finally { await handle.close(); }
        } else throw new Error("Special files and symbolic links are unsupported");
        await rejectLinks(path);
        if (identity(await lstat(path, { bigint: true })) !== identity(before)) throw new Error("Inspected entry changed during capture");
      };
      await walk("", 0);
      observation.entries.sort((left, right) => left.path.localeCompare(right.path));
    } catch (error) {
      observation.status = "unavailable";
      observation.entries = []; // Never judge a partial inventory as a complete tree.
      observation.error = error instanceof Error ? error.message : String(error);
    }
  }
  const profileSha256 = fileProfileHash(profile);
  return { profileSha256, startedAt, capturedAt: new Date().toISOString(), roots, bytesRead: budget.bytes, snapshotHash: sha256(JSON.stringify({ profileSha256, roots })) };
}
