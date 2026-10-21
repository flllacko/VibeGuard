import { z } from "zod";

/** Compatibility marker, not a claim that a host has trusted or executed its Hook. */
export const CONNECTION_RESOURCE = "vibeguard://connection";
export const CONNECTION_REVISION = "2026-10-21.external-http.v1";
export const ConnectionInfoSchema = z.object({
  schemaVersion: z.literal(1),
  protocolRevision: z.literal(CONNECTION_REVISION),
  verifyParameters: z.tuple([z.literal("externalPlanRef"), z.literal("captureTicket")]),
  diagnosticOnly: z.literal(true),
}).strict();

export function connectionInfo() {
  return ConnectionInfoSchema.parse({ schemaVersion: 1, protocolRevision: CONNECTION_REVISION,
    verifyParameters: ["externalPlanRef", "captureTicket"], diagnosticOnly: true });
}

const ToolSchema = z.object({ name: z.string(), inputSchema: z.unknown() });
const InputSchema = z.object({ type: z.literal("object"), properties: z.record(z.string(), z.unknown()) });
const ReferenceSchema = z.object({ type: z.literal("string"), format: z.literal("uuid") });

/** Inspect the advertised wire schema, not tool names or a version string alone. */
export function inspectConnectionTools(tools: unknown): { compatible: boolean; issues: string[] } {
  const parsed = z.array(ToolSchema).safeParse(tools);
  if (!parsed.success) return { compatible: false, issues: ["工具列表格式无法识别"] };
  const issues: string[] = [];
  for (const name of ["verify_task", "get_verification", "read_evidence"]) {
    if (parsed.data.filter(tool => tool.name === name).length !== 1) issues.push(`缺少或重复工具：${name}`);
  }
  const schema = InputSchema.safeParse(parsed.data.find(tool => tool.name === "verify_task")?.inputSchema);
  for (const name of ["externalPlanRef", "captureTicket"]) {
    if (!schema.success || !ReferenceSchema.safeParse(schema.data.properties[name]).success) issues.push(`缺少或不兼容参数：verify_task.${name}`);
  }
  return { compatible: issues.length === 0, issues };
}
