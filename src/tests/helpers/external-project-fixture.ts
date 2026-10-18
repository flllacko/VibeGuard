import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConversationSchema, type Conversation } from "../../intake.js";
import { intentUnits } from "../../intent-units.js";
import type { Resolution } from "../../requirements.js";
import { saveResolution } from "../../resolution-storage.js";
import { registerTask } from "../../task-registry.js";
import { applyRequirementReviewReply, createRequirementReview, requirementReviewView } from "../../requirement-review.js";
import { ProjectProfileSchema } from "../../project-profile.js";
import { prepareExternalProject } from "../../external-project.js";

/** Synthetic original messages and approval, always labelled as such. No model or live host. */
export async function prepareRuntimeFixture(directory: string, script: string, timeoutMs = 2000) {
  const dataDir = join(directory, "data"), root = join(directory, "source");
  await mkdir(dataDir, { recursive: true }); await mkdir(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "synthetic-runtime-fixture", type: "module", private: true }));
  await writeFile(join(root, "server.mjs"), script);
  await writeFile(join(root, ".env"), "SYNTHETIC_SECRET=must-not-enter-container");
  const profile = ProjectProfileSchema.parse({ schemaVersion: 1, projectId: "synthetic-runtime-fixture", description: "Synthetic lifecycle fixture; not a human acceptance task",
    projectRoot: root, runtime: { kind: "docker", image: "node:24-bookworm-slim", command: ["node", "server.mjs"], containerPort: 3000, readiness: { path: "/health", timeoutMs } } });
  const profilePath = join(directory, "project.json"); await writeFile(profilePath, JSON.stringify(profile));
  const quote = "启动一个可访问的文本服务。";
  const source = ConversationSchema.parse({ schemaVersion: 1, taskId: "synthetic-runtime-task", sessionId: `synthetic-runtime-${randomUUID()}`, host: "synthetic-test-host",
    taskBoundary: { startMessageId: "u1", endMessageId: "u1" }, transcriptCoverage: { level: "complete", source: "user_export", basis: "Synthetic runtime test only", missingMessageIds: [] },
    messages: [{ id: "u1", role: "user", sequence: 1, text: quote }] });
  const task = async (conversation: Conversation) => {
    const path = join(directory, `${randomUUID()}.conversation.json`); await writeFile(path, JSON.stringify(conversation)); return registerTask(dataDir, path);
  };
  const original = await task(source);
  const resolution: Resolution = { schemaVersion: 1, resolutionId: randomUUID(), taskId: source.taskId, createdAt: new Date().toISOString(), conversationSha256: original.conversationSha256,
    transcriptCoverage: source.transcriptCoverage, coverageIssues: [], revisions: [{ requirementId: "reachable-service", revision: 1, status: "active", normalized: quote, sourceKind: "explicit_user",
      sourceRefs: [{ messageId: "u1", start: 0, end: quote.length, quote }] }], dispositions: [{ messageId: "u1", kind: "requirements", reason: "Synthetic fixture" }],
    interpretedUnits: intentUnits(source.messages).map(unit => ({ ...unit, kind: "requirement", requirementIds: ["reachable-service"], reason: "Synthetic fixture" })),
    processing: [{ chunk: 1, messageIds: ["u1"], status: "processed", model: "fixture-no-api" }], unprocessedUserMessageIds: [], resolutionComplete: true };
  await saveResolution(resolution, dataDir);
  const draft = await createRequirementReview(dataDir, original.taskRef, resolution.resolutionId), fresh = structuredClone(source);
  fresh.transcriptCoverage.source = "host_adapter";
  fresh.messages.push({ id: "display", role: "assistant", sequence: 2, text: requirementReviewView(draft).text }, { id: "confirmation", role: "user", sequence: 3, text: "确认" });
  fresh.taskBoundary.endMessageId = "confirmation";
  const current = await task(fresh), review = await applyRequirementReviewReply(dataDir, current.taskRef, { reviewRef: draft.reviewRef });
  const prepared = await prepareExternalProject(dataDir, profilePath, review.reviewRef, current.taskRef);
  return { dataDir, root, profile, ...prepared };
}
