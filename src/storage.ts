import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EvidenceRecord, RunReport } from "./contracts.js";

export class EvidenceStore {
  private db: DatabaseSync;
  constructor(private dataDir: string) {
    this.db = new DatabaseSync(join(dataDir, "runs.sqlite"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        report_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence (
        evidence_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );
    `);
  }

  static async open(dataDir: string): Promise<EvidenceStore> {
    await mkdir(dataDir, { recursive: true });
    return new EvidenceStore(dataDir);
  }

  async save(report: RunReport, records: EvidenceRecord[]): Promise<void> {
    const rows: { record: EvidenceRecord; relativePath: string; sha256: string }[] = [];
    await mkdir(join(this.dataDir, "evidence", report.runId), { recursive: true });
    for (const record of records) {
      const relativePath = join("evidence", report.runId, `${record.evidenceId}.json`);
      const bytes = Buffer.from(JSON.stringify(record, null, 2) + "\n");
      await writeFile(join(this.dataDir, relativePath), bytes, { flag: "wx" });
      rows.push({ record, relativePath, sha256: sha256(bytes) });
    }
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO runs (run_id, created_at, report_json) VALUES (?, ?, ?)")
        .run(report.runId, report.createdAt, JSON.stringify(report));
      const insert = this.db.prepare("INSERT INTO evidence (evidence_id, run_id, check_id, relative_path, sha256) VALUES (?, ?, ?, ?, ?)");
      for (const row of rows) {
        insert.run(row.record.evidenceId, report.runId, row.record.checkId, row.relativePath, row.sha256);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getReport(runId: string): RunReport | null {
    const row = this.db.prepare("SELECT report_json FROM runs WHERE run_id = ?").get(runId) as { report_json: string } | undefined;
    return row ? JSON.parse(row.report_json) as RunReport : null;
  }

  async getEvidence(evidenceId: string): Promise<{ record: EvidenceRecord; sha256: string } | null> {
    const row = this.db.prepare("SELECT relative_path, sha256 FROM evidence WHERE evidence_id = ?")
      .get(evidenceId) as { relative_path: string; sha256: string } | undefined;
    if (!row) return null;
    const bytes = await readFile(join(this.dataDir, row.relative_path));
    if (sha256(bytes) !== row.sha256) throw new Error("Evidence content hash mismatch");
    return { record: JSON.parse(bytes.toString()) as EvidenceRecord, sha256: row.sha256 };
  }

  close(): void { this.db.close(); }
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
