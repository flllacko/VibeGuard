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
