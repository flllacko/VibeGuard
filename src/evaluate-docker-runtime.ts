import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DockerCli, commandSucceeded, type DockerClient } from "./docker-client.js";
import { checkExternalProjectRuntime } from "./docker-runtime.js";
import { readRuntimeReport } from "./runtime-store.js";
import { prepareRuntimeFixture } from "./tests/helpers/external-project-fixture.js";

const args = process.argv.slice(2), out = args[args.indexOf("--out") + 1];
const GOOD = `import http from 'node:http';import fs from 'node:fs';import os from 'node:os';let writable=true;try{fs.writeFileSync('/workspace/unexpected-write','x')}catch{writable=false}console.log('synthetic runtime fixture started');http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ready:true,uid:process.getuid(),secretPresent:fs.existsSync('/workspace/.env'),workspaceWritable:writable,interfaces:Object.keys(os.networkInterfaces())}))}).listen(Number(process.env.PORT),'127.0.0.1');`;
const cases = [
  { id: "ready", script: GOOD, timeoutMs: 10000, expected: "ready" },
  { id: "crash", script: "console.error('synthetic startup failure');process.exit(7);", timeoutMs: 3000, expected: "unavailable" },
  { id: "not-ready", script: "import http from 'node:http';http.createServer((req,res)=>{res.statusCode=503;res.end('synthetic not ready')}).listen(Number(process.env.PORT),'127.0.0.1');", timeoutMs: 1500, expected: "unavailable" },
  { id: "cancel-after-start", script: GOOD, timeoutMs: 10000, expected: "cancelled" },
] as const;

async function main() {
  if (!args.includes("--run-live") || !args.includes("--out") || !out || !isAbsolute(out)) throw new Error("Explicit live Docker evaluation: node dist/evaluate-docker-runtime.js --run-live --out ABSOLUTE_NEW_DIRECTORY");
  await mkdir(out); // Refuse replacing any existing run, including failed evidence.
  await writeFile(join(out, "case-set.json"), JSON.stringify({ schemaVersion: 1, material: "synthetic messages and local application", cases: cases.map(({ script, ...item }) => ({ ...item, script })),
    meaning: "Real Docker lifecycle execution, not real human review or general task acceptance. No model API." }, null, 2));
  const results: object[] = [];
  for (const item of cases) {
    const directory = join(out, item.id); await mkdir(directory);
    const fixture = await prepareRuntimeFixture(directory, item.script, item.timeoutMs), controller = new AbortController(), cli = new DockerCli();
    const client: DockerClient = { async invoke(command, options) {
      const result = await cli.invoke(command, options);
      if (item.id === "cancel-after-start" && command[0] === "start" && commandSucceeded(result)) controller.abort();
      return result;
    } };
    const report = await checkExternalProjectRuntime(fixture.dataDir, fixture.project.projectRef, { client, signal: controller.signal });
    const reasons: string[] = [];
    if (report.status !== item.expected) reasons.push(`Expected ${item.expected}, observed ${report.status}: ${report.reason}`);
    if (report.cleanup.status !== "removed") reasons.push(`Cleanup: ${report.cleanup.status}: ${report.cleanup.reason}`);
    if (report.stage !== "readiness") reasons.push(`Expected readiness stage, observed ${report.stage}`);
    if (!report.events.some(event => event.step === "start" && commandSucceeded(event.result))) reasons.push("Project start was not observed");
    if (item.id === "crash" && !report.events.some(event => event.step === "state" && commandSucceeded(event.result) && JSON.parse(event.result.stdout).ExitCode === 7)) reasons.push("Expected actual project exit code 7");
    if (item.id === "not-ready" && !report.events.some(event => event.step === "readiness" && commandSucceeded(event.result) && JSON.parse(event.result.stdout).status === 503)) reasons.push("Expected actual HTTP 503");
    if (item.id === "ready" && report.status === "ready") {
      const probe = report.events.find(event => {
        if (event.step !== "readiness" || !commandSucceeded(event.result)) return false;
        const value = JSON.parse(event.result.stdout);
        return value.status === 200 && !value.error && typeof value.bodyBase64 === "string";
      });
      assert.ok(probe, "Expected a successful HTTP readiness observation");
      const observed = JSON.parse(Buffer.from(JSON.parse(probe!.result.stdout).bodyBase64, "base64").toString("utf8"));
      assert.equal(observed.uid, 1000); assert.equal(observed.secretPresent, false); assert.equal(observed.workspaceWritable, false); assert.deepEqual(observed.interfaces, ["lo"]);
    }
    const restored = await readRuntimeReport(fixture.dataDir, report.runId);
    assert.equal(restored.targetSnapshotHash, fixture.project.targetSnapshotHash); assert.equal(restored.verdict, "UNVERIFIABLE");
    const summary = { id: item.id, expected: item.expected, status: report.status, matched: reasons.length === 0, cleanup: report.cleanup.status,
      runId: report.runId, projectRef: fixture.project.projectRef, dataDir: fixture.dataDir, stage: report.stage, reason: report.reason, reasons, imageId: report.imageId, verdict: report.verdict };
    results.push(summary); console.log(JSON.stringify(summary));
  }
  await writeFile(join(out, "summary.json"), JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), kind: "real-docker-synthetic-lifecycle", modelCalls: 0, businessAcceptance: false, results }, null, 2));
  if (results.some(item => !(item as { matched: boolean }).matched)) process.exitCode = 2;
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
