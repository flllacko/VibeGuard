import { z } from "zod";

export const TaskSchema = z.object({
  taskId: z.string().min(1),
  coverage: z.literal("complete-for-demo"),
  messages: z.array(z.object({
    id: z.string().min(1),
    role: z.enum(["user", "assistant"]),
    text: z.string(),
  })).min(1),
});

export type Task = z.infer<typeof TaskSchema>;
export type Verdict = "VERIFIED" | "FAILED" | "UNVERIFIABLE";
export type DemoVariant = "correct" | "faulty" | "unavailable";

export interface SourceRef {
  messageId: string;
  start: number;
  end: number;
  quote: string;
}

export interface EvidenceRecord {
  evidenceId: string;
  checkId: string;
  collector: "vibeguard-http";
  capturedAt: string;
  request: { method: string; url: string; body?: unknown };
  response?: { status: number; body: unknown };
  storedOrder?: { status: number; body: unknown };
  error?: string;
}

export interface CheckResult {
  checkId: string;
  label: string;
  expected: string;
  observed: string;
  verdict: Verdict;
  evidenceId: string;
  reason: string;
}

export interface RunReport {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  createdAt: string;
  variant: DemoVariant;
  scope: "manual-coupon-threshold-plan";
  sourceRefs: SourceRef[];
  requirement: string;
  deliveryClaim: string;
  codeSnapshotHash: string;
  planHash: string;
  checks: CheckResult[];
  /** Verdict for the explicitly limited threshold scope. */
  verdict: Verdict;
  /** The entire user task also includes single-use behavior, still unchecked in M1. */
  taskVerdict: Verdict;
  limitations: string[];
}
