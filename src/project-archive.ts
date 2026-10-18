import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { pack } from "tar-stream";
import type { ProjectProfile } from "./project-profile.js";
import { projectSnapshotDirectory, readProjectSnapshot } from "./project-snapshot.js";
import { sha256 } from "./storage.js";

/** Only recorded files/directories enter the archive; never symlinks or host ownership. */
export async function createProjectArchive(dataDir: string, snapshotRef: string, profile: ProjectProfile, outputPath: string, signal?: AbortSignal) {
  const snapshot = await readProjectSnapshot(dataDir, snapshotRef, profile);
  const archive = pack(), output = pipeline(archive, createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
  void output.catch(() => {});
  const entry = (name: string, type: "file" | "directory", contents?: Buffer) => new Promise<void>((resolve, reject) => {
    archive.entry({ name, type, size: contents?.length ?? 0, mode: type === "directory" ? 0o555 : 0o444, uid: 1000, gid: 1000, mtime: new Date(0) }, contents ?? Buffer.alloc(0), error => error ? reject(error) : resolve());
  });
  try {
    await entry("workspace", "directory");
    for (const file of snapshot.entries) {
      signal?.throwIfAborted();
      const bytes = file.kind === "file" ? await readFile(join(projectSnapshotDirectory(dataDir, snapshotRef), "files", file.path)) : undefined;
      if (bytes && (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)) throw new Error("Snapshot changed while archiving");
      await entry(`workspace/${file.path}`, file.kind, bytes);
    }
    archive.finalize(); await output;
    await readProjectSnapshot(dataDir, snapshotRef, profile);
  } catch (error) { archive.destroy(error instanceof Error ? error : new Error("Archive failed")); await output.catch(() => {}); throw error; }
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(outputPath)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest("hex"), bytes };
}
