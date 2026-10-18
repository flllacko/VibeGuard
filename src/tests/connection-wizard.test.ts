import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "smol-toml";
import { applyConnection, connectionPreview, mergeCodexMcp, prepareConnection } from "../connection-install.js";
import { checkConnection } from "../connection-doctor.js";
import { buildConnectionConfig } from "../connection-config.js";

const installDir = fileURLToPath(new URL("../../", import.meta.url));
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "vibeguard-connect-"));
  return { directory, homeDir: join(directory, "home"), dataDir: join(directory, "data"), installDir };
}
async function cleanup(directory: string) {
  const absolute = resolve(directory);
  assert.equal(dirname(absolute), resolve(tmpdir()));
  assert.ok(absolute.startsWith(join(resolve(tmpdir()), "vibeguard-connect-")));
  await rm(absolute, { recursive: true, force: true });
}

test("Codex connection merges only its tables, preserves comments/settings, and is idempotent", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.homeDir, ".codex"), { recursive: true });
    const configPath = join(f.homeDir, ".codex", "config.toml");
    const original = '# retain this comment\nmodel = "my-model"\napproval_policy = "on-request"\n[features]\nflag = true\n[mcp_servers.other]\ncommand = "other-program"\n';
    await writeFile(configPath, original);
    const hooksPath = join(f.homeDir, ".codex", "hooks.json");
    const otherHook = { matcher: "^Other$", hooks: [{ type: "command", command: "echo existing-hook" }] };
    await writeFile(hooksPath, JSON.stringify({ description: "keep", hooks: { PreToolUse: [otherHook], Stop: [{ hooks: [{ type: "command", command: "other-stop" }] }] } }));
    const plan = await prepareConnection("codex", f);
    assert.equal(await readFile(configPath, "utf8"), original);
    assert.equal(plan.edits.length, 2);
    assert.doesNotMatch(JSON.stringify(connectionPreview(plan)), /approval_policy|my-model/);
    const applied = await applyConnection(plan);
    assert.equal(applied.hostCollectionVerified, false);
    const mergedText = await readFile(configPath, "utf8");
    assert.ok(mergedText.startsWith(original));
    const merged = parse(mergedText) as any;
    assert.equal(merged.model, "my-model");
    assert.equal(merged.approval_policy, "on-request");
    assert.equal(merged.mcp_servers.other.command, "other-program");
    assert.deepEqual(merged.mcp_servers.vibeguard.env_vars, ["DEEPSEEK_API_KEY"]);
    const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
    assert.deepEqual(hooks.hooks.PreToolUse[0], otherHook);
    assert.equal(hooks.hooks.Stop[0].hooks[0].command, "other-stop");
    assert.equal(hooks.hooks.PreToolUse.length, 2);
    const repeated = await prepareConnection("codex", f);
    assert.equal(repeated.edits.length, 0);
    assert.deepEqual((await applyConnection(repeated)).changedFiles, []);
  } finally { await cleanup(f.directory); }
});

test("Codex existing entry is updated without changing other parsed values or remote configuration", () => {
  const text = '# before\nvalue = 1.0\n[mcp_servers.vibeguard]\ncommand = "old"\nenabled = false\n[mcp_servers.vibeguard.tools.read]\napproval_mode = "prompt"\n[mcp_servers.other]\ncommand = "other"\n';
  const updated = mergeCodexMcp(text, { command: "new", args: ["app.js"] });
  const parsed = parse(updated) as any;
  assert.equal(parsed.value, 1);
  assert.equal(parsed.mcp_servers.vibeguard.command, "new");
  assert.equal(parsed.mcp_servers.vibeguard.enabled, false);
  assert.equal(parsed.mcp_servers.vibeguard.tools.read.approval_mode, "prompt");
  assert.ok(updated.startsWith('# before\nvalue = 1.0\n'));
  assert.match(updated, /\[mcp_servers.other\]\ncommand = "other"/);
  assert.throws(() => mergeCodexMcp('[mcp_servers.vibeguard]\nurl="https://example.invalid"', { command: "new" }), /远程/);
  assert.throws(() => mergeCodexMcp('mcp_servers = {vibeguard={command="old"}}', { command: "new" }), /内联/);
  assert.throws(() => mergeCodexMcp('broken = [', { command: "new" }), /TOML/);
});

test("Claude connection keeps other servers, settings and hook disabling, without copying credentials", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.homeDir, ".claude"), { recursive: true });
    const secret = "sentinel-not-a-real-key";
    await writeFile(join(f.homeDir, ".claude.json"), JSON.stringify({ privateValue: secret, mcpServers: { other: { command: "other" } } }));
    await writeFile(join(f.homeDir, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "default" }, disableAllHooks: true, hooks: { Stop: [{ hooks: [{ command: "existing" }] }] } }));
    const plan = await prepareConnection("claude-code", f);
    assert.doesNotMatch(JSON.stringify(connectionPreview(plan)), new RegExp(secret));
    assert.equal(plan.warnings.some(warning => warning.includes("禁用")), true);
    await applyConnection(plan);
    const config = JSON.parse(await readFile(join(f.homeDir, ".claude.json"), "utf8"));
    assert.equal(config.privateValue, secret);
    assert.equal(config.mcpServers.other.command, "other");
    assert.equal(config.mcpServers.vibeguard.env.DEEPSEEK_API_KEY, "${DEEPSEEK_API_KEY}");
    const settings = JSON.parse(await readFile(join(f.homeDir, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.disableAllHooks, true);
    assert.equal(settings.permissions.defaultMode, "default");
    assert.equal(settings.hooks.Stop[0].hooks[0].command, "existing");
    assert.equal((await prepareConnection("claude-code", f)).edits.length, 0);
  } finally { await cleanup(f.directory); }
});

test("invalid JSON, existing conflicting collectors, and link paths fail before writing", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.homeDir, ".codex"), { recursive: true });
    const config = join(f.homeDir, ".codex", "config.toml");
    await writeFile(config, 'model="keep"\n');
    const hooksPath = join(f.homeDir, ".codex", "hooks.json");
    await writeFile(hooksPath, "invalid-json");
    await assert.rejects(prepareConnection("codex", f), /JSON/);
    assert.equal(await readFile(config, "utf8"), 'model="keep"\n');
    const old = buildConnectionConfig("codex", { ...f, dataDir: join(f.directory, "different-data") });
    await writeFile(hooksPath, JSON.stringify(old.collector.hooksJson));
    await assert.rejects(prepareConnection("codex", f), /已有不同路径/);
    const target = join(f.directory, "actual-home");
    await mkdir(target);
    const linked = join(f.directory, "linked-home");
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(prepareConnection("codex", { ...f, homeDir: linked }), /链接|junction/);
  } finally { await cleanup(f.directory); }
});

test("configuration changed after preview aborts all writes", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.homeDir, ".codex"), { recursive: true });
    const config = join(f.homeDir, ".codex", "config.toml");
    await writeFile(config, 'model="first"\n');
    const plan = await prepareConnection("codex", f);
    await writeFile(config, 'model="changed-by-user"\n');
    await assert.rejects(applyConnection(plan), /预览后发生变化/);
    assert.equal(await readFile(config, "utf8"), 'model="changed-by-user"\n');
    await assert.rejects(readFile(join(f.homeDir, ".codex", "hooks.json")), { code: "ENOENT" });
  } finally { await cleanup(f.directory); }
});

test("noninteractive connect only previews unless explicitly authorized; doctor does not invent host success", async () => {
  const f = await fixture();
  try {
    const output = await new Promise<string>((accept, reject) => {
      const child = spawn(process.execPath, [join(installDir, "dist", "cli.js"), "connect", "codex", "--home-dir", f.homeDir, "--data-dir", f.dataDir, "--format", "json"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", () => {});
      child.on("error", reject);
      child.on("exit", code => code === 0 ? accept(stdout) : reject(new Error(`CLI exited ${code}`)));
    });
    assert.equal(JSON.parse(output).changes.length, 2);
    await assert.rejects(readFile(join(f.homeDir, ".codex", "config.toml")), { code: "ENOENT" });
    await applyConnection(await prepareConnection("codex", f));
    const doctor = await checkConnection("codex", f);
    assert.equal(doctor.status, "needs_host_check");
    assert.equal(doctor.checks.find(check => check.name === "工具连接")!.status, "passed");
    for (const name of ["当前对话采集", "项目读取", "证据保存与读回"]) assert.equal(doctor.checks.find(check => check.name === name)!.status, "pending");
    assert.doesNotMatch(JSON.stringify(doctor), /sk-[A-Za-z0-9]/);
  } finally { await cleanup(f.directory); }
});
