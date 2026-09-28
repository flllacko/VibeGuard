import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TaskSchema, type CheckResult, type DemoVariant, type EvidenceRecord, type RunReport, type SourceRef, type Task, type Verdict } from "./contracts.js";
import { startDemoServer } from "./demo-app.js";
import { EvidenceStore, sha256 } from "./storage.js";

interface PlannedCheck {
  id: string;
  label: string;
  amountCents: number;
  couponCode: string;
  expectedDiscountCents: number;
}

// M1 deliberately uses a hand-written plan. M2/M3 must replace this with
// requirement resolution and planning from the actual task transcript.
const checks: PlannedCheck[] = [
  { id: "threshold-150", label: "150 元订单获得 20 元优惠", amountCents: 15000, couponCode: "SAVE20-A", expectedDiscountCents: 2000 },
  { id: "threshold-149", label: "149 元订单不获得优惠", amountCents: 14900, couponCode: "SAVE20-B", expectedDiscountCents: 0 },
];

export async function verifyDemo(variant: DemoVariant, store: EvidenceStore): Promise<RunReport> {
  const task = TaskSchema.parse(JSON.parse(await readFile(new URL("../fixtures/conversations/coupon-demo.json", import.meta.url), "utf8")));
  const sources = sourceRefs(task);
  const code = await readFile(new URL("./demo-app.js", import.meta.url));
  const report: RunReport = {
    schemaVersion: 1,
    runId: randomUUID(),
    taskId: task.taskId,
    createdAt: new Date().toISOString(),
    variant,
    scope: "manual-coupon-threshold-plan",
    sourceRefs: sources,
    requirement: "订单满 150 元减 20 元；低于 150 元不得优惠",
    deliveryClaim: task.messages.findLast(message => message.role === "assistant")?.text ?? "",
    codeSnapshotHash: sha256(Buffer.concat([code, Buffer.from(`\nvariant=${variant}`)])),
    planHash: sha256(JSON.stringify(checks)),
    checks: [],
    verdict: "UNVERIFIABLE",
    taskVerdict: "UNVERIFIABLE",
    limitations: [
      "本轮只验收门槛；每张券只能使用一次尚未验证，不能宣称整个任务已完成。",
      "验收计划由开发者手写，尚未从任意完整对话自动整理要求与规划检查。",
      "运行的是本项目自编演示应用；外部 Agent 交付物的容器隔离尚未实现。",
      "代码摘要只覆盖演示应用编译文件与变体配置，并非整个项目工作树快照。",
    ],
  };
  const records: EvidenceRecord[] = [];
  const server = await startDemoServer(variant === "faulty");
  try {
    if (variant === "unavailable") await server.close();
    for (const check of checks) {
      const { result, record } = await executeCheck(server.baseUrl, check, report.runId);
      report.checks.push(result);
      records.push(record);
    }
  } finally {
    if (variant !== "unavailable") await server.close();
  }
  report.verdict = combine(report.checks.map(check => check.verdict));
  report.taskVerdict = report.verdict === "FAILED" ? "FAILED" : "UNVERIFIABLE";
  await store.save(report, records);
  return report;
}

function sourceRefs(task: Task): SourceRef[] {
  return [
    source(task, "u1", "订单满 100 元减 20 元"),
    source(task, "u2", "门槛改成满 150 元，其他规则不变。"),
  ];
}

function source(task: Task, messageId: string, quote: string): SourceRef {
  const message = task.messages.find(item => item.id === messageId && item.role === "user");
  if (!message) throw new Error(`Missing user message ${messageId}`);
  const start = message.text.indexOf(quote);
  if (start < 0) throw new Error(`Quote does not occur verbatim in ${messageId}`);
  const end = start + quote.length;
  if (message.text.slice(start, end) !== quote) throw new Error("Quote mismatch");
  return { messageId, start, end, quote };
}

async function executeCheck(baseUrl: string, check: PlannedCheck, runId: string): Promise<{ result: CheckResult; record: EvidenceRecord }> {
  const request = { method: "POST", url: `${baseUrl}/checkout`, body: { amountCents: check.amountCents, couponCode: check.couponCode } };
  const record: EvidenceRecord = {
    evidenceId: randomUUID(),
    checkId: check.id,
    collector: "vibeguard-http",
    capturedAt: new Date().toISOString(),
    request,
  };
  const result: CheckResult = {
    checkId: check.id,
    label: check.label,
    expected: `折扣 ${check.expectedDiscountCents} 分；订单金额 ${check.amountCents} 分`,
    observed: "未执行",
    verdict: "UNVERIFIABLE",
    evidenceId: record.evidenceId,
    reason: "",
  };
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(5000),
    });
    const body = await readResponse(response);
    record.response = { status: response.status, body };
    if (response.status !== 201 || !isOrder(body)) {
      result.verdict = "FAILED";
      result.observed = `结算接口 HTTP ${response.status}，响应 ${JSON.stringify(body)}`;
      result.reason = "应用已响应，但未生成符合格式的订单";
      return { result, record };
    }
    const orderResponse = await fetch(`${baseUrl}/orders/${encodeURIComponent(body.orderId)}`, { signal: AbortSignal.timeout(5000) });
    const stored = await readResponse(orderResponse);
    record.storedOrder = { status: orderResponse.status, body: stored };
    if (orderResponse.status !== 200 || !isStoredOrder(stored)) {
      result.verdict = "FAILED";
      result.observed = `订单查询 HTTP ${orderResponse.status}，响应 ${JSON.stringify(stored)}`;
      result.reason = "结算响应无法由实际保存的订单证实";
      return { result, record };
    }
    result.observed = `订单 ${body.orderId}：实际折扣 ${stored.discountCents} 分，实付 ${stored.totalCents} 分`;
    const matched = stored.amountCents === check.amountCents &&
      stored.discountCents === check.expectedDiscountCents &&
      stored.totalCents === check.amountCents - check.expectedDiscountCents &&
      body.discountCents === stored.discountCents;
    result.verdict = matched ? "VERIFIED" : "FAILED";
    result.reason = matched ? "真实结算请求与保存的订单共同满足断言" : "保存的订单与用户门槛要求不符";
  } catch (error) {
    record.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    result.observed = `请求未完成：${record.error}`;
    result.reason = "无法取得应用运行结果，不能判断功能是否正确";
  }
  return { result, record };
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function isOrder(value: unknown): value is { orderId: string; discountCents: number } {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.orderId === "string" && Number.isSafeInteger(row.discountCents);
}

function isStoredOrder(value: unknown): value is { amountCents: number; discountCents: number; totalCents: number } {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.amountCents) && Number.isSafeInteger(row.discountCents) && Number.isSafeInteger(row.totalCents);
}

function combine(results: Verdict[]): Verdict {
  if (results.includes("FAILED")) return "FAILED";
  if (results.includes("UNVERIFIABLE") || results.length === 0) return "UNVERIFIABLE";
  return "VERIFIED";
}
