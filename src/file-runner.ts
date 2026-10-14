import { randomUUID } from "node:crypto";
import type { Verdict } from "./contracts.js";
import { assertFilePlanMatchesProfile, fileProfileHash, type FileCheck, type FileProfile, type FileRef } from "./file-profile.js";
import { captureFileSnapshot, type FileEntry, type FileSnapshot } from "./file-snapshot.js";
import { freezePlan, type FrozenPlan } from "./planning.js";
import type { PlannedRunReport } from "./plan-runner.js";
import { currentRequirements, type Resolution } from "./requirements.js";

export const FILE_RUNNER_VERSION = "readonly-files-v1";
export interface FileEvidence {
  evidenceId: string; checkId: string; capturedAt: string; collector: "vibeguard-file";
  type: "file_snapshot" | "entry_exists" | "tree_compare";
  snapshot?: FileSnapshot; check?: FileCheck; observed?: Record<string, unknown>;
  snapshotEvidenceIds?: string[]; verdict?: Verdict; reason?: string;
}

function combine(verdicts: Verdict[]): Verdict {
  return verdicts.includes("FAILED") ? "FAILED" : !verdicts.length || verdicts.includes("UNVERIFIABLE") ? "UNVERIFIABLE" : "VERIFIED";
}

function subtree(snapshot: FileSnapshot, ref: FileRef): { status: "present" | "missing" | "unavailable"; entries: FileEntry[]; error?: string } {
  const root = snapshot.roots.find(item => item.rootId === ref.rootId);
  if (!root) throw new Error("Snapshot is missing an authorized root");
  if (root.status !== "present") return root;
  const entries = root.entries.filter(entry => ref.path === "" || entry.path === ref.path || entry.path.startsWith(`${ref.path}/`))
    .map(entry => ({ ...entry, path: ref.path === "" ? entry.path : entry.path === ref.path ? "" : entry.path.slice(ref.path.length + 1) }));
  return { status: entries.length ? "present" : "missing", entries };
}

function inspect(check: FileCheck, snapshot: FileSnapshot): { verdict: Verdict; reason: string; observed: Record<string, unknown> } {
  const target = subtree(snapshot, check.target);
  if (target.status === "unavailable") return { verdict: "UNVERIFIABLE", reason: target.error ?? "交付目录未取得完整清单", observed: { targetStatus: target.status } };
  if (check.type === "entry_exists") {
    const actualKind = target.entries.find(entry => entry.path === "")?.kind ?? "missing";
    const verdict = actualKind === check.expectedKind ? "VERIFIED" : "FAILED";
    return { verdict, reason: verdict === "VERIFIED" ? "实际读取到预期位置及文件类型" : `实际 ${actualKind}，预期 ${check.expectedKind}`, observed: { actualKind, expectedKind: check.expectedKind } };
  }
  const reference = subtree(snapshot, check.reference);
  if (reference.status !== "present") return { verdict: "UNVERIFIABLE", reason: reference.error ?? "参考源不存在，不能建立内容对照", observed: { referenceStatus: reference.status, targetStatus: target.status } };
  const left = new Map(reference.entries.map(entry => [entry.path, entry]));
  const right = new Map(target.entries.map(entry => [entry.path, entry]));
  const missing = [...left.keys()].filter(path => !right.has(path));
  const extra = [...right.keys()].filter(path => !left.has(path));
  const changed = [...left].filter(([path, entry]) => {
    const actual = right.get(path);
    return actual && (entry.kind !== actual.kind || (check.comparison === "content" && entry.kind === "file" && entry.sha256 !== actual.sha256));
  }).map(([path]) => path);
  const count = (entries: FileEntry[]) => ({ files: entries.filter(entry => entry.kind === "file").length, directories: entries.filter(entry => entry.kind === "directory" && entry.path !== "").length });
  const verdict = missing.length || extra.length || changed.length ? "FAILED" : "VERIFIED";
  return { verdict, reason: verdict === "VERIFIED" ? (check.comparison === "content" ? "相对路径、类型及逐文件 SHA-256 均一致" : "相对路径及类型一致；此检查不证明文件内容相同") : `缺失 ${missing.length} 项，增加 ${extra.length} 项，变化 ${changed.length} 项`, observed: { comparison: check.comparison, reference: count(reference.entries), target: count(target.entries), missing, extra, changed } };
}

export async function runFilePlan(plan: FrozenPlan, resolution: Resolution, profile: FileProfile, initial?: FileSnapshot): Promise<{ report: PlannedRunReport; evidence: FileEvidence[] }> {
  const validated = freezePlan(resolution, { criteria: plan.criteria, coverage: plan.coverage }, plan.source);
  if (validated.planHash !== plan.planHash || plan.conversationSha256 !== resolution.conversationSha256 || validated.requirementSnapshotHash !== plan.requirementSnapshotHash) throw new Error("File plan does not match current requirement snapshot");
  assertFilePlanMatchesProfile(plan, profile);
  const before = initial ?? await captureFileSnapshot(profile);
  if (before.profileSha256 !== fileProfileHash(profile)) throw new Error("File snapshot profile mismatch");
  const after = await captureFileSnapshot(profile);
  const stable = before.snapshotHash === after.snapshotHash;
  const evidence: FileEvidence[] = [before, after].map(snapshot => ({ evidenceId: randomUUID(), checkId: "file-snapshot", capturedAt: snapshot.capturedAt, collector: "vibeguard-file", type: "file_snapshot", snapshot }));
  const snapshotEvidenceIds = evidence.map(item => item.evidenceId);
  const report: PlannedRunReport = {
    schemaVersion: 1, kind: "planned-file-run", runId: randomUUID(), createdAt: new Date().toISOString(),
    planHash: plan.planHash, targetSnapshotHash: before.snapshotHash, resolutionId: resolution.resolutionId,
    conversationSha256: resolution.conversationSha256, source: plan.source, environment: "VibeGuard 独立进程只读本地文件；未执行项目代码",
    criteria: [], requirements: [], verdict: "UNVERIFIABLE",
    limitations: [
      "只证明本次读取时的文件事实，不能还原历史交付瞬间，也不能证明宿主已加载技能或程序运行正常。",
      "读前读后核对内容和元数据以发现变化；未加文件系统锁，不能称为抵抗同权限恶意修改的强隔离快照。",
      "符号链接、junction、特殊文件、超限或读取失败不跟随执行，相关检查返回无法验证。",
      "本地哈希可发现读取时的证据变化；不能抵抗同权限主体同时改写证据与清单。",
      plan.source === "manual-fixture" ? "本次使用人工计划，不能证明模型自行规划能力。" : "模型计划的语义与覆盖质量仍需复核。",
      ...(!stable ? ["两次读取的目标状态不同，本轮文件检查均无法验证；需对稳定交付重新验收。"] : []),
    ],
  };
  for (const criterion of plan.criteria) {
    const checks: PlannedRunReport["criteria"][number]["checks"] = [];
    for (const candidate of criterion.checks) {
      if (candidate.type === "http_sequence") throw new Error("Read-only file runner does not execute HTTP checks");
      const result = stable ? inspect(candidate, before) : { verdict: "UNVERIFIABLE" as const, reason: "读取期间目标状态发生变化", observed: { beforeSnapshotHash: before.snapshotHash, afterSnapshotHash: after.snapshotHash } };
      const item: FileEvidence = { evidenceId: randomUUID(), checkId: candidate.checkId, capturedAt: after.capturedAt, collector: "vibeguard-file", type: candidate.type, check: candidate, ...result, snapshotEvidenceIds };
      evidence.push(item);
      checks.push({ checkId: candidate.checkId, verdict: result.verdict, reason: result.reason, evidenceIds: [...snapshotEvidenceIds, item.evidenceId] });
    }
    report.criteria.push({ criterionId: criterion.criterionId, verdict: combine(checks.map(check => check.verdict)), checks });
  }
  for (const requirement of currentRequirements(resolution.revisions)) {
    const coverage = plan.coverage.find(row => row.requirementId === requirement.requirementId)!;
    const criteria = report.criteria.filter(criterion => coverage.criterionIds.includes(criterion.criterionId));
    const verdict = combine(criteria.map(criterion => criterion.verdict));
    const decisive = criteria.flatMap(criterion => criterion.checks).find(check => check.verdict === "FAILED") ?? criteria.flatMap(criterion => criterion.checks).find(check => check.verdict === "UNVERIFIABLE");
    report.requirements.push({ requirementId: requirement.requirementId, normalized: requirement.normalized, sourceRefs: requirement.sourceRefs,
      verdict: coverage.status === "planned" || verdict === "FAILED" ? verdict : "UNVERIFIABLE",
      reason: coverage.status !== "planned" ? coverage.gapReason! : decisive?.reason ?? "冻结文件检查实际执行且满足；原始清单及哈希已保存",
      evidenceIds: [...new Set(criteria.flatMap(criterion => criterion.checks.flatMap(check => check.evidenceIds)))],
    });
  }
  report.verdict = combine(report.requirements.map(requirement => requirement.verdict));
  return { report, evidence };
}
