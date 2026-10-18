import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { DockerCli, commandSucceeded, type DockerClient, type DockerCommandOptions } from "./docker-client.js";
import { readExternalProject } from "./external-project.js";
import { ProjectRelativePath } from "./project-profile.js";
import { createProjectArchive } from "./project-archive.js";
import { readProjectSnapshot } from "./project-snapshot.js";
import { runtimeDirectory, saveRuntimeReport, type RuntimeReport } from "./runtime-store.js";

const LABEL = "io.vibeguard.runtime", NODE = "/usr/local/bin/node";
// Fixed collector code; user paths and port are separate argv, not executable source.
export const READINESS_PROBE = `const http=require('node:http');let done=false;const finish=x=>{if(done)return;done=true;process.stdout.write(JSON.stringify(x)+'\\n')};const req=http.get({host:'127.0.0.1',port:Number(process.argv[1]),path:process.argv[2],timeout:1000},res=>{const chunks=[];let bytes=0;res.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096){finish({status:res.statusCode,error:'BODY_LIMIT'});req.destroy();return}chunks.push(chunk)});res.on('end',()=>finish({status:res.statusCode,bodyBase64:Buffer.concat(chunks).toString('base64'),bodyBytes:bytes}));res.on('error',()=>finish({error:'RESPONSE_ERROR'}))});req.on('timeout',()=>{finish({error:'REQUEST_TIMEOUT'});req.destroy()});req.on('error',e=>finish({error:e.code||'REQUEST_ERROR'}));`;
const ProbeSchema = z.object({ status: z.number().int().optional(), bodyBase64: z.string().max(6000).optional(), bodyBytes: z.number().int().min(0).max(4096).optional(), error: z.string().max(80).optional() }).strict();

export function runtimeCreateArgs(name: string, runId: string, imageId: string, port: number, command: string[]): string[] {
  if (!/^vibeguard-[a-f0-9-]{36}$/.test(name) || !z.string().uuid().safeParse(runId).success || !/^sha256:[a-f0-9]{64}$/.test(imageId) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid controlled runtime identity");
  return ["create", "--name", name, "--label", `${LABEL}=${runId}`, "--pull", "never", "--network", "none", "--user", "1000:1000", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "256m", "--memory-swap", "256m", "--cpus", "1", "--pids-limit", "64", "--init",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=67108864,uid=1000,gid=1000", "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=2",
    "--env", `PORT=${port}`, "--env", "HOME=/tmp", "--env", "NODE_OPTIONS=", "--env", "NODE_PATH=", "--workdir", "/workspace", "--entrypoint", NODE, imageId, ...command.slice(1)];
}
function assertContainerInspection(value: any, runId: string, imageId: string, port: number, command: string[], readOnly = true) {
  const host = value.HostConfig, config = value.Config;
  if (config?.Labels?.[LABEL] !== runId || config.User !== "1000:1000" || config.Image !== imageId || value.Path !== NODE || JSON.stringify(value.Args) !== JSON.stringify(command.slice(1)) ||
    host?.NetworkMode !== "none" || host.Privileged !== false || host.ReadonlyRootfs !== readOnly || !host.CapDrop?.includes("ALL") || !host.SecurityOpt?.includes("no-new-privileges") ||
    host.Memory !== 268435456 || host.MemorySwap !== 268435456 || host.NanoCpus !== 1000000000 || host.PidsLimit !== 64 || host.Binds?.length || Object.keys(host.PortBindings ?? {}).length ||
    (value.Mounts ?? []).some((mount: any) => mount.Type !== "tmpfs" || mount.Destination !== "/tmp") || !config.Env?.includes(`PORT=${port}`)) throw new Error("Docker did not retain required runtime isolation settings");
}
class RuntimeStop extends Error {}

export async function checkExternalProjectRuntime(dataDir: string, projectRef: string, options: { client?: DockerClient; signal?: AbortSignal } = {}): Promise<RuntimeReport> {
  const { project, profile, snapshot } = await readExternalProject(dataDir, projectRef);
  const runId = randomUUID(), containerName = `vibeguard-${runId}`, directory = runtimeDirectory(dataDir, runId);
  await mkdir(directory, { recursive: true });
  const report: RuntimeReport = { schemaVersion: 1, kind: "docker-runtime-check", runnerVersion: "docker-runtime-v1", runId, projectRef, projectRecordHash: project.recordHash,
    targetSnapshotHash: snapshot.snapshotHash, profileSha256: project.profileSha256, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    status: "unavailable", verdict: "UNVERIFIABLE", stage: "configuration", reason: "尚未完成运行检查", containerName, events: [], cleanup: { status: "not_needed", reason: "尚未创建容器" },
    limitations: ["只验证项目启动和就绪，不代表任何用户功能已验收。", "首版只支持已缓存的官方 Node 24 bookworm-slim 镜像与直接 Node 入口；没有依赖安装、外部网络、外部数据库或宿主端口。",
      "项目副本按只读文件部署；仅 /tmp 可临时写入。探测在同一容器内运行，不能称为抵御所有恶意进程干扰的独立可信观察。", "本地记录哈希不证明同权限进程无法篡改事实。"] };
  const client = options.client ?? new DockerCli();
  let createAttempted = false, createUncertain = false, stagingAttempted = false, stagingUncertain = false, commitUncertain = false;
  const invoke = async (step: string, args: string[], commandOptions: DockerCommandOptions = {}) => {
    const result = await client.invoke(args, commandOptions);
    report.events.push({ step, args, result }); return result;
  };
  const required = async (step: string, args: string[], commandOptions: DockerCommandOptions = {}) => {
    const result = await invoke(step, args, { timeoutMs: 15000, signal: options.signal, ...commandOptions });
    if (!commandSucceeded(result)) throw new RuntimeStop(`${step} 未成功；原始退出、超时和输出已保存。`);
    return result;
  };
  try {
    options.signal?.throwIfAborted();
    if (!["node:24-bookworm-slim", "docker.io/library/node:24-bookworm-slim"].includes(profile.runtime.image)) throw new RuntimeStop("首版运行器只接受官方 Node 24 bookworm-slim 镜像配置。");
    const command = profile.runtime.command, script = command[1];
    if (command[0] !== "node" || !script || script.startsWith("-") || !/\.(?:mjs|cjs|js)$/.test(script) || !ProjectRelativePath.safeParse(script).success || !snapshot.entries.some(entry => entry.path === script && entry.kind === "file")) throw new RuntimeStop("当前需要副本中的直接 Node JavaScript 入口；npm 安装和其他启动方式尚不支持。");
    report.stage = "docker";
    const engine = await required("docker_info", ["info", "--format", "{{json .OSType}}"]);
    if (JSON.parse(engine.stdout.trim()) !== "linux") throw new RuntimeStop("当前运行器需要 Linux Docker Engine。");
    report.stage = "image";
    const image = await required("image_inspect", ["image", "inspect", profile.runtime.image, "--format", "{{json .Id}}"]);
    report.imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(JSON.parse(image.stdout.trim()));
    report.stage = "archive";
    const archivePath = join(directory, "source.tar");
    report.archive = await createProjectArchive(dataDir, snapshot.snapshotRef, profile, archivePath, options.signal);
    // Populate a stopped, never-executed staging container, then freeze it into a run-owned image.
    report.stage = "create"; stagingAttempted = true;
    const stagingArgs = runtimeCreateArgs(containerName, runId, report.imageId, profile.runtime.containerPort, command);
    stagingArgs.splice(stagingArgs.indexOf("--read-only"), 1);
    stagingArgs[stagingArgs.indexOf("--name") + 1] = `${containerName}-stage`;
    const staged = await invoke("create_staging", stagingArgs, { timeoutMs: 15000, signal: options.signal });
    stagingUncertain = staged.timedOut || staged.aborted || Boolean(staged.errorCode) || staged.outputTruncated;
    if (!commandSucceeded(staged)) throw new RuntimeStop("准备容器创建结果未确认。");
    report.stagingContainerId = z.string().regex(/^[a-f0-9]{64}$/).parse(staged.stdout.trim());
    const stageInspection = JSON.parse((await required("inspect_staging", ["inspect", report.stagingContainerId, "--format", "{{json .}}"])).stdout.trim());
    assertContainerInspection(stageInspection, runId, report.imageId, profile.runtime.containerPort, command, false);
    if (stageInspection.State?.Running !== false) throw new RuntimeStop("准备容器不得运行项目。");
    report.stage = "copy";
    await required("copy", ["cp", "-", `${report.stagingContainerId}:/`], { inputFile: archivePath, timeoutMs: 30000 });
    report.stage = "integrity";
    await readProjectSnapshot(dataDir, snapshot.snapshotRef, profile);
    report.runtimeImageRef = `vibeguard-runtime:${runId}`;
    const committed = await invoke("commit", ["commit", report.stagingContainerId, report.runtimeImageRef], { timeoutMs: 30000, signal: options.signal });
    commitUncertain = committed.timedOut || committed.aborted || Boolean(committed.errorCode) || committed.outputTruncated;
    if (!commandSucceeded(committed)) throw new RuntimeStop("交付临时镜像生成未成功或结果不确定。");
    // Commit output may contain CLI notices; recover the immutable identity through a typed inspect.
    const runtimeImage = await required("runtime_image_inspect", ["image", "inspect", report.runtimeImageRef, "--format", "{{json .Id}}"]);
    report.runtimeImageId = z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(JSON.parse(runtimeImage.stdout.trim()));
    if (report.runtimeImageId === report.imageId) throw new RuntimeStop("临时交付镜像身份未与基础镜像分离。");
    report.stage = "create"; createAttempted = true;
    const created = await invoke("create", runtimeCreateArgs(containerName, runId, report.runtimeImageId, profile.runtime.containerPort, command), { timeoutMs: 15000, signal: options.signal });
    createUncertain = created.timedOut || created.aborted || Boolean(created.errorCode) || created.outputTruncated;
    if (!commandSucceeded(created)) throw new RuntimeStop("验收容器创建未成功或结果不确定。");
    report.containerId = z.string().regex(/^[a-f0-9]{64}$/).parse(created.stdout.trim());
    const inspection = await required("inspect_created", ["inspect", report.containerId, "--format", "{{json .}}"]);
    assertContainerInspection(JSON.parse(inspection.stdout.trim()), runId, report.runtimeImageId, profile.runtime.containerPort, command);
    report.stage = "start";
    await required("start", ["start", report.containerId]);
    report.stage = "readiness";
    const deadline = Date.now() + profile.runtime.readiness.timeoutMs;
    for (let attempt = 0; attempt < 60 && Date.now() < deadline; attempt++) {
      options.signal?.throwIfAborted();
      const result = await invoke("readiness", ["exec", "--workdir", "/", "--env", "NODE_OPTIONS=", "--env", "NODE_PATH=", report.containerId, NODE, "--input-type=commonjs", "-e", READINESS_PROBE, String(profile.runtime.containerPort), profile.runtime.readiness.path],
        { timeoutMs: Math.max(1, Math.min(3500, deadline - Date.now())), signal: options.signal, maxOutputBytes: 16384 });
      let ready = false;
      if (commandSucceeded(result)) {
        const probe = ProbeSchema.safeParse((() => { try { return JSON.parse(result.stdout.trim()); } catch { return null; } })());
        ready = probe.success && !probe.data.error && probe.data.status === profile.runtime.readiness.expectedStatus;
      }
      const state = await required("state", ["inspect", report.containerId, "--format", "{{json .State}}"], { timeoutMs: 5000 });
      if (JSON.parse(state.stdout.trim()).Running !== true) throw new RuntimeStop("项目在就绪检查前已经退出；退出状态与日志已记录。");
      if (ready) { report.status = "ready"; report.reason = "容器中实际请求返回配置的就绪状态码；用户功能尚未验收。"; break; }
      if (attempt < 59) await delay(Math.min(200, Math.max(0, deadline - Date.now())), undefined, { signal: options.signal });
    }
    if (report.status !== "ready") throw new RuntimeStop("项目未在有界时间/次数内达到就绪条件。");
  } catch (error) {
    report.status = options.signal?.aborted ? "cancelled" : "unavailable";
    report.reason = options.signal?.aborted ? "用户取消运行检查；仍尝试收集日志并清理本次容器。" : (error instanceof Error ? error.message : "运行检查异常").slice(0, 2400);
  } finally {
    const cleanupProblems: string[] = [];
    let removed = false;
    for (const resource of [
      { attempted: createAttempted, target: report.containerId ?? containerName, uncertain: createUncertain },
      { attempted: stagingAttempted, target: report.stagingContainerId ?? `${containerName}-stage`, uncertain: stagingUncertain },
    ]) {
      if (!resource.attempted) continue;
      const target = resource.target;
      try {
        const owned = await invoke("cleanup_inspect", ["inspect", target, "--format", "{{json .Config.Labels}}"], { timeoutMs: 5000 });
        if (commandSucceeded(owned) && JSON.parse(owned.stdout.trim())?.[LABEL] === runId) {
          await invoke("logs", ["logs", "--tail", "200", target], { timeoutMs: 5000 });
          const removed = await invoke("remove", ["rm", "--force", "--volumes", target], { timeoutMs: 10000 });
          const absent = await invoke("cleanup_verify", ["inspect", target, "--format", "{{json .Id}}"], { timeoutMs: 5000 });
          if (!commandSucceeded(removed) || commandSucceeded(absent) || !/No such (?:object|container)/i.test(absent.stderr)) cleanupProblems.push("容器移除未确认");
        } else if (commandSucceeded(owned) || !/No such (?:object|container)/i.test(owned.stderr) || resource.uncertain) cleanupProblems.push("容器身份、创建或连接不确定");
        removed = true;
      } catch { cleanupProblems.push("容器清理检查异常"); }
    }
    if (report.runtimeImageRef) {
      try {
        const target = report.runtimeImageRef;
        const owned = await invoke("image_cleanup_inspect", ["image", "inspect", target, "--format", "{{json .Config.Labels}}"], { timeoutMs: 5000 });
        if (commandSucceeded(owned) && JSON.parse(owned.stdout.trim())?.[LABEL] === runId) {
          const removed = await invoke("image_remove", ["image", "rm", target], { timeoutMs: 10000 });
          const absent = await invoke("image_cleanup_verify", ["image", "inspect", target, "--format", "{{json .Id}}"], { timeoutMs: 5000 });
          if (!commandSucceeded(removed) || commandSucceeded(absent) || !/No such image/i.test(absent.stderr)) cleanupProblems.push("临时镜像移除未确认");
        } else if (commandSucceeded(owned) || !/No such image/i.test(owned.stderr) || commitUncertain) cleanupProblems.push("临时镜像身份、提交或连接不确定");
      } catch { cleanupProblems.push("临时镜像清理异常"); }
    }
    report.cleanup = cleanupProblems.length ? { status: "incomplete", reason: cleanupProblems.join("；") } : removed
      ? { status: "removed", reason: "已核对本次身份，回收准备/验收容器及已生成的临时镜像。" } : { status: "not_needed", reason: "未创建运行资源。" };
    if (report.cleanup.status === "incomplete" && report.status === "ready") { report.status = "unavailable"; report.reason = "项目曾达到就绪，但容器清理未确认，运行检查未完整结束。"; }
    report.completedAt = new Date().toISOString();
    await saveRuntimeReport(dataDir, report);
  }
  return report;
}
