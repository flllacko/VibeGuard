import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { VerifyTaskInputSchema } from "../mcp-contract.js";
import { CONNECTION_RESOURCE, ConnectionInfoSchema, connectionInfo, inspectConnectionTools } from "../connection-protocol.js";

test("same three tool names do not establish compatibility with external execution", () => {
  const tools = ["verify_task", "get_verification", "read_evidence"].map(name => ({ name, inputSchema: { type: "object", properties: {} } }));
  const old = inspectConnectionTools(tools);
  assert.equal(old.compatible, false);
  assert.deepEqual(old.issues, ["缺少或不兼容参数：verify_task.externalPlanRef", "缺少或不兼容参数：verify_task.captureTicket"]);
  tools[0]!.inputSchema = z.toJSONSchema(VerifyTaskInputSchema, { io: "input" }) as typeof tools[0]["inputSchema"];
  assert.equal(inspectConnectionTools(tools).compatible, true);
  assert.equal(inspectConnectionTools([...tools, tools[0]]).compatible, false);
  const broken = structuredClone(tools);
  (broken[0]!.inputSchema.properties as Record<string, unknown>).captureTicket = { type: "number" };
  assert.equal(inspectConnectionTools(broken).compatible, false);
  assert.equal(inspectConnectionTools({ tools }).compatible, false);
  assert.equal(ConnectionInfoSchema.safeParse({ ...connectionInfo(), protocolRevision: "old" }).success, false);
});

test("real MCP connection resource is read-only, works without a model, and never starts bound history capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-protocol-"));
  const client = new Client({ name: "connection-probe", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("../mcp-entry.js", import.meta.url)), "--data-dir", directory,
        "--codex-thread", randomUUID(), "--codex-bin", "vibeguard-test-must-not-launch-history"],
      env: { PATH: "", DEEPSEEK_API_KEY: "", MOONSHOT_API_KEY: "" }, stderr: "pipe" }));
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["get_verification", "read_evidence", "verify_task"]);
    assert.equal(inspectConnectionTools(tools).compatible, true);
    assert.ok((await client.listResources()).resources.some(resource => resource.uri === CONNECTION_RESOURCE));
    const result = await client.readResource({ uri: CONNECTION_RESOURCE });
    assert.equal(result.contents.length, 1);
    const content = result.contents[0]!;
    assert.ok("text" in content);
    assert.deepEqual(ConnectionInfoSchema.parse(JSON.parse(content.text as string)), connectionInfo());
    await assert.rejects(client.readResource({ uri: "file:///must-not-read" }));
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await client.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
});
