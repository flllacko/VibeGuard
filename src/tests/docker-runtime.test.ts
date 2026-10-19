import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { extract } from "tar-stream";
import { DockerCli, commandSucceeded, type DockerClient, type DockerCommandOptions, type DockerCommandResult } from "../docker-client.js";
import { checkExternalProjectRuntime, READINESS_PROBE } from "../docker-runtime.js";
import { readRuntimeReport, runtimeDirectory } from "../runtime-store.js";
import { projectSnapshotDirectory } from "../project-snapshot.js";
import { prepareRuntimeFixture } from "./helpers/external-project-fixture.js";
import { createExternalPlan } from "../external-plan.js";
import { ApiProfileSchema, type PlanGatewayOutput } from "../pi-plan-gateway.js";
import { readExternalEvidence, readExternalRun, runExternalPlan } from "../external-runner.js";
import { HTTP_COLLECTOR, dockerHttpTransport } from "../docker-http.js";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execute = promisify(execFile);

const result = (stdout = "", exitCode = 0, stderr = ""): DockerCommandResult => ({ stdout, stderr, exitCode, signal: null, timedOut: false, aborted: false, outputTruncated: false, durationMs: 1 });
class FakeDocker implements DockerClient {
  calls: { args: string[]; options?: DockerCommandOptions }[] = [];
  runId = ""; removed = new Set<string>(); imageRemoved = false;
  constructor(readonly mode: "ready" | "missing" | "crash" | "remove_failure" | "alien_label" | "bad_isolation" = "ready", private controller?: AbortController) {}
  async invoke(args: string[], options?: DockerCommandOptions) {
    this.calls.push({ args, options });
    if (options?.signal?.aborted) return { ...result("", 1), aborted: true };
    if (args[0] === "info") return this.mode === "missing" ? result("", 1, "Cannot connect to Docker daemon") : result('"linux"');
    if (args[0] === "image") {
      if (args[1] === "rm") { if (this.mode === "remove_failure") return result("", 1, "in use"); this.imageRemoved = true; return result(); }
      if (args[2] === `sha256:${"d".repeat(64)}` || args[2]?.startsWith("vibeguard-runtime:")) {
        if (this.imageRemoved) return result("", 1, "Error: No such image");
        return args.at(-1) === "{{json .Config.Labels}}" ? result(JSON.stringify({ "io.vibeguard.runtime": this.runId })) : result(JSON.stringify(`sha256:${"d".repeat(64)}`));
      }
      return result(JSON.stringify(`sha256:${"a".repeat(64)}`));
    }
    if (args[0] === "create") { this.runId = args[args.indexOf("--label") + 1]!.split("=")[1]!; return result((args[args.indexOf("--name") + 1]!.endsWith("-stage") ? "c" : "b").repeat(64)); }
    if (args[0] === "commit") return result(`Informational CLI notice\nsha256:${"d".repeat(64)}`);
    if (args[0] === "cp") { assert.ok(options?.inputFile); assert.ok((await readFile(options.inputFile)).length > 1024); return result(); }
    if (args[0] === "exec") { this.controller?.abort(); return result(JSON.stringify({ status: 200, bodyBase64: "b2s=", bodyBytes: 2 })); }
    if (args[0] === "start") return result("b".repeat(64));
    if (args[0] === "logs") return result("synthetic project log");
    if (args[0] === "rm") { if (this.mode === "remove_failure") return result("", 1, "permission denied"); this.removed.add(args.at(-1)!); return result(); }
    if (args[0] === "inspect") {
      const format = args.at(-1);
      if (this.removed.has(args[1]!)) return result("", 1, "Error: No such object");
      if (format === "{{json .Config.Labels}}") return result(JSON.stringify({ "io.vibeguard.runtime": this.mode === "alien_label" ? "another-run" : this.runId }));
      if (format === "{{json .State}}") return result(JSON.stringify({ Running: this.mode !== "crash", ExitCode: this.mode === "crash" ? 7 : 0 }));
      if (format === "{{json .Id}}") return result(JSON.stringify("b".repeat(64)));
      const staging = args[1] === "c".repeat(64);
      return result(JSON.stringify({ Path: "/usr/local/bin/node", Args: ["server.mjs"], Mounts: [], State: { Running: false },
        Config: { User: "1000:1000", Image: `sha256:${(staging ? "a" : "d").repeat(64)}`, Labels: { "io.vibeguard.runtime": this.runId }, Env: ["PORT=3000"] },
        HostConfig: { NetworkMode: "none", Privileged: this.mode === "bad_isolation", ReadonlyRootfs: !staging, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Memory: 268435456, MemorySwap: 268435456, NanoCpus: 1000000000, PidsLimit: 64, Binds: null, PortBindings: {} } }));
    }
    throw new Error(`Unexpected Docker test command: ${args[0]}`);
  }
}
async function temporary(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-docker-runtime-"));
  try { await action(directory); } finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
}

test("Docker CLI bounds output, time and cancellation without shell execution", async () => {
  const cli = new DockerCli(process.execPath);
  assert.ok(commandSucceeded(await cli.invoke(["-e", "process.stdout.write('ok')"])));
  assert.equal((await cli.invoke(["-e", "process.stdout.write('x'.repeat(10000))"], { maxOutputBytes: 10 })).outputTruncated, true);
  assert.equal((await cli.invoke(["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 })).timedOut, true);
  const controller = new AbortController(); controller.abort();
  assert.equal((await cli.invoke(["-e", "throw Error('must not run')"], { signal: controller.signal })).aborted, true);
  assert.equal((await new DockerCli("vibeguard-no-such-docker").invoke([])).errorCode, "ENOENT");
});

test("runtime archives exact snapshot bytes read-only, uses constrained image identity, records readiness and cleans up", async () => temporary(async directory => {
  const fixture = await prepareRuntimeFixture(directory, "// not executed by unit test\n"), docker = new FakeDocker();
  const report = await checkExternalProjectRuntime(fixture.dataDir, fixture.project.projectRef, { client: docker });
  assert.equal(report.status, "ready"); assert.equal(report.verdict, "UNVERIFIABLE"); assert.equal(report.cleanup.status, "removed");
  const create = docker.calls.find(call => call.args[0] === "create" && !call.args[call.args.indexOf("--name") + 1]!.endsWith("-stage"))!.args;
  for (const forbidden of ["--privileged", "--publish", "--mount", "--volume", "--use-api-socket"]) assert.equal(create.includes(forbidden), false);
  assert.equal(create[create.indexOf("--network") + 1], "none"); assert.equal(create[create.indexOf("--pull") + 1], "never");
  assert.ok(create.includes(`sha256:${"d".repeat(64)}`)); assert.equal(create.includes(fixture.profile.runtime.image), false);
  assert.deepEqual(docker.calls.filter(call => call.args[0] === "start").map(call => call.args[1]), ["b".repeat(64)]);
  const parser = extract(), headers: { name: string; mode: number; uid: number }[] = [];
  const consumed = (async () => { for await (const entry of parser) { headers.push({ name: entry.header.name, mode: entry.header.mode!, uid: entry.header.uid! }); entry.resume(); } })();
  createReadStream(join(runtimeDirectory(fixture.dataDir, report.runId), "source.tar")).pipe(parser); await consumed;
  assert.deepEqual(headers.map(header => header.name), ["workspace", "workspace/package.json", "workspace/server.mjs"]);
  assert.ok(headers.every(header => header.uid === 1000 && (header.mode & 0o222) === 0));
  assert.equal((await readRuntimeReport(fixture.dataDir, report.runId)).targetSnapshotHash, fixture.project.targetSnapshotHash);
  await writeFile(join(runtimeDirectory(fixture.dataDir, report.runId), "report.json"), "{}");
  await assert.rejects(readRuntimeReport(fixture.dataDir, report.runId));
}));

test("Docker unavailable produces a retained environment gap without host fallback or implicit image download", async () => temporary(async directory => {
  const fixture = await prepareRuntimeFixture(directory, "// no host fallback"), docker = new FakeDocker("missing");
  const report = await checkExternalProjectRuntime(fixture.dataDir, fixture.project.projectRef, { client: docker });
  assert.equal(report.status, "unavailable"); assert.equal(report.stage, "docker"); assert.equal(report.verdict, "UNVERIFIABLE");
  assert.equal(report.cleanup.status, "not_needed"); assert.equal(docker.calls.length, 1);
}));

test("project exit and changed isolation settings cannot become ready; owned containers still get cleaned", async () => temporary(async directory => {
  for (const mode of ["crash", "bad_isolation"] as const) {
    const root = join(directory, mode); await mkdir(root);
    const fixture = await prepareRuntimeFixture(root, "process.exit(7)"), docker = new FakeDocker(mode);
    const report = await checkExternalProjectRuntime(fixture.dataDir, fixture.project.projectRef, { client: docker });
    assert.equal(report.status, "unavailable"); assert.equal(report.cleanup.status, "removed");
    if (mode === "bad_isolation") assert.equal(docker.calls.some(call => call.args[0] === "cp" || call.args[0] === "start"), false);
  }
}));

test("cleanup failure is visible and mismatched container ownership is never removed", async () => temporary(async directory => {
  for (const mode of ["remove_failure", "alien_label"] as const) {
    const root = join(directory, mode); await mkdir(root);
    const fixture = await prepareRuntimeFixture(root, "// no real docker"), docker = new FakeDocker(mode);
    const report = await checkExternalProjectRuntime(fixture.dataDir, fixture.project.projectRef, { client: docker });
    assert.equal(report.status, "unavailable"); assert.equal(report.cleanup.status, "incomplete");
    if (mode === "alien_label") assert.equal(docker.calls.some(call => call.args[0] === "rm"), false);
  }
}));

test("cancellation still cleans up with independent bounded commands; corrupt snapshots never start Docker", async () => temporary(async directory => {
  const fixture = await prepareRuntimeFixture(directory, "// synthetic"), controller = new AbortController(), docker = new FakeDocker("ready", controller);
  const report = await checkExternalProjectRuntime(fixture.dataDir, fixture.project.projectRef, { client: docker, signal: controller.signal });
  assert.equal(report.status, "cancelled"); assert.equal(report.cleanup.status, "removed");
  assert.ok(docker.calls.filter(call => ["rm", "logs"].includes(call.args[0]!)).every(call => call.options?.signal === undefined));
  await writeFile(join(projectSnapshotDirectory(fixture.dataDir, fixture.project.snapshotRef), "files", "server.mjs"), "corrupted");
  const untouched = new FakeDocker(); await assert.rejects(checkExternalProjectRuntime(fixture.dataDir, fixture.project.projectRef, { client: untouched }), /contents changed/);
  assert.equal(untouched.calls.length, 0);
}));

test("readiness probe parameters remain argv data rather than executable source", () => {
  assert.match(READINESS_PROBE, /process\.argv\[2\]/); assert.match(READINESS_PROBE, /127\.0\.0\.1/);
  assert.equal(READINESS_PROBE.includes("eval("), false);
});

const api = ApiProfileSchema.parse({ schemaVersion: 1, profileId: "synthetic-status", description: "Only for orchestration tests", routes: [
  { method: "GET", pathTemplate: "/health", description: "Read health", successStatus: 200, responseExample: "ok" }], isolationRules: [] });
function syntheticPlan(fail = false): PlanGatewayOutput {
  return { model: "fixture-no-api", promptHash: "a".repeat(64), usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, proposal: {
    criteria: [{ criterionId: "available", requirementIds: ["reachable-service"], sourceKind: "explicit_user", description: "读取服务", expected: "响应符合要求", preconditions: [], checks: [
      { checkId: "http", type: "http_sequence", purpose: "读取", timeoutMs: 2000, steps: [{ stepId: "read", method: "GET", pathTemplate: "/health", expectedStatus: 200, captures: [], assertions: fail ? [{ pointer: "", equals: "expected" }] : [] }] }] }],
    coverage: [{ requirementId: "reachable-service", criterionIds: ["available"], status: "planned" }],
  } };
}

test("external lifecycle with synthetic Docker saves three verdicts, actual-command references and cross-process evidence; archived reports survive later source changes", async () => temporary(async directory => {
  for (const kind of ["correct", "faulty", "unavailable"] as const) {
    const root = join(directory, kind); await mkdir(root);
    const fixture = await prepareRuntimeFixture(root, "// synthetic unit-test delivery");
    const plan = await createExternalPlan(fixture.dataDir, fixture.project.projectRef, api, { async propose() { return syntheticPlan(kind === "faulty"); } });
    const docker = new FakeDocker(kind === "unavailable" ? "crash" : "ready");
    const run = await runExternalPlan(fixture.dataDir, plan.planRef, { client: docker });
    assert.equal(run.verdict, kind === "correct" ? "VERIFIED" : kind === "faulty" ? "FAILED" : "UNVERIFIABLE");
    const first = docker.calls.findIndex(call => call.args.includes(HTTP_COLLECTOR));
    const clean = docker.calls.findIndex(call => call.args[0] === "rm");
    if (kind !== "unavailable") {
      assert.ok(first > 0 && clean > first); assert.equal(run.evidenceIds.length, 1);
      const evidence: any = await readExternalEvidence(fixture.dataDir, run.runId, run.evidenceIds[0]!);
      assert.equal(evidence.response.status, 200); assert.equal(evidence.observation.runtimeRunId, run.runtime!.runId);
      const command = await execute(process.execPath, ["dist/cli.js", "project-evidence", run.runId, run.evidenceIds[0]!, "--data-dir", fixture.dataDir]);
      assert.deepEqual(JSON.parse(command.stdout), evidence);
    } else assert.deepEqual(run.evidenceIds, []);
    await writeFile(join(fixture.dataDir, "external-plans", `${plan.planRef}.json`), "changed after run");
    await writeFile(join(projectSnapshotDirectory(fixture.dataDir, fixture.project.snapshotRef), "files", "server.mjs"), "new source");
    const readback = await execute(process.execPath, ["dist/cli.js", "project-report", run.runId, "--format", "json", "--data-dir", fixture.dataDir]);
    assert.equal(JSON.parse(readback.stdout).verdict, run.verdict);
  }
}));

test("external cleanup failures and unobserved preconditions cannot become verified; evidence tampering is rejected", async () => temporary(async directory => {
  const fixture = await prepareRuntimeFixture(directory, "// synthetic");
  const output = syntheticPlan(); output.proposal.criteria[0]!.preconditions = ["一个尚未核对的条件"];
  const plan = await createExternalPlan(fixture.dataDir, fixture.project.projectRef, api, { async propose() { return output; } });
  const run = await runExternalPlan(fixture.dataDir, plan.planRef, { client: new FakeDocker() });
  assert.equal(run.verdict, "UNVERIFIABLE"); assert.match(run.report!.requirements[0]!.reason, /前置条件/);
  const plain = await createExternalPlan(fixture.dataDir, fixture.project.projectRef, api, { async propose() { return syntheticPlan(); } });
  const failedCleanup = await runExternalPlan(fixture.dataDir, plain.planRef, { client: new FakeDocker("remove_failure") });
  assert.equal(failedCleanup.verdict, "UNVERIFIABLE"); assert.equal(failedCleanup.runtime!.cleanup.status, "incomplete");
  const id = run.evidenceIds[0]!;
  await writeFile(join(fixture.dataDir, "external-runs", run.runId, "observations", `${id}.json`), "{}");
  await assert.rejects(readExternalRun(fixture.dataDir, run.runId));
}));

test("missing completion record preserves journal evidence as incomplete, never passed", async () => temporary(async directory => {
  const fixture = await prepareRuntimeFixture(directory, "// synthetic");
  const plan = await createExternalPlan(fixture.dataDir, fixture.project.projectRef, api, { async propose() { return syntheticPlan(); } });
  const run = await runExternalPlan(fixture.dataDir, plan.planRef, { client: new FakeDocker() });
  await rm(join(fixture.dataDir, "external-runs", run.runId, "finish.json"));
  const incomplete = await readExternalRun(fixture.dataDir, run.runId);
  assert.equal(incomplete.status, "incomplete"); assert.equal(incomplete.verdict, "UNVERIFIABLE"); assert.equal(incomplete.journal!.length, 1);
  assert.equal((await readExternalEvidence(fixture.dataDir, run.runId, run.evidenceIds[0]!) as any).response.status, 200);
}));

test("cancellation after an observation preserves evidence and cleans resources; later steps are not invented", async () => temporary(async directory => {
  const fixture = await prepareRuntimeFixture(directory, "// synthetic");
  const output = syntheticPlan();
  const check = output.proposal.criteria[0]!.checks[0]!;
  assert.equal(check.type, "http_sequence"); if (check.type !== "http_sequence") throw Error("fixture");
  check.steps.push({ ...check.steps[0]!, stepId: "second" });
  const plan = await createExternalPlan(fixture.dataDir, fixture.project.projectRef, api, { async propose() { return output; } });
  const controller = new AbortController(), docker = new FakeDocker();
  const run = await runExternalPlan(fixture.dataDir, plan.planRef, { signal: controller.signal, client: { async invoke(args, options) {
    const response = await docker.invoke(args, options);
    if (args.includes(HTTP_COLLECTOR)) controller.abort();
    return response;
  } } });
  assert.equal(run.verdict, "UNVERIFIABLE"); assert.equal(run.runtime!.status, "cancelled"); assert.equal(run.runtime!.cleanup.status, "removed");
  assert.equal(run.evidenceIds.length, 1); assert.equal(docker.calls.filter(call => call.args.includes(HTTP_COLLECTOR)).length, 1);
}));

test("fixed HTTP collector makes real requests, keeps redirects local, bounds bodies/time and never evaluates request content", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/large") { res.end("x".repeat(70000)); return; }
    if (req.url === "/slow") { return; }
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://example.invalid/" }); res.end(); return; }
    let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ received: body ? JSON.parse(body) : null })); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const cli = new DockerCli(process.execPath); let calls = 0;
  const transport = dockerHttpTransport({ runId: "11111111-1111-4111-8111-111111111111", containerId: "b".repeat(64), port: address.port,
    async invoke(args, options) { calls++; return { result: await cli.invoke(["--input-type=commonjs", "-e", HTTP_COLLECTOR, args.at(-1)!], options), eventIndex: calls }; } });
  try {
    const body = { text: "'; throw Error('must remain data'); //" };
    assert.deepEqual((await transport({ method: "POST", path: "/echo", body }, 2000)).response?.body, { received: body });
    assert.equal((await transport({ method: "GET", path: "/redirect" }, 2000)).response?.status, 302);
    assert.equal((await transport({ method: "GET", path: "/large" }, 2000)).error, "BODY_LIMIT");
    assert.equal((await transport({ method: "GET", path: "/slow" }, 100)).error, "REQUEST_TIMEOUT");
    const before = calls;
    await assert.rejects(transport({ method: "GET", path: "//elsewhere" }, 1000)); assert.equal(calls, before);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
