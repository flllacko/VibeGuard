import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse as pathParts, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "smol-toml";
import { buildConnectionConfig, type ConnectionOptions } from "./connection-config.js";
import type { SupportedCollector } from "./capture-hook.js";
import { sha256 } from "./storage.js";

type ObjectValue = Record<string, any>;
interface Edit { path: string; before: string | null; after: string; mode: number; purpose: string }
export interface ConnectionInstallation {
  host: SupportedCollector;
  guide: ReturnType<typeof buildConnectionConfig>;
  edits: Edit[];
  warnings: string[];
}
export interface InstallOptions extends ConnectionOptions { homeDir?: string }
function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是配置对象；未修改文件。`);
  return value as ObjectValue;
}
const tomlOptions = { integersAsBigInt: true, unsafeKeyBehaviour: "throw" } as const;
const tomlWriteOptions = { numbersAsFloat: true } as const;

/** All existing ancestor directories and the final target must be ordinary paths. */
async function rejectLinks(path: string): Promise<void> {
  const absolute = resolve(path);
  const base = pathParts(absolute).root;
  let current = base;
  for (const part of absolute.slice(base.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("配置路径包含链接或 junction；请使用平台的实际配置位置。"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
async function readConfig(path: string): Promise<{ text: string | null; mode: number }> {
  await rejectLinks(path);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("配置不是普通文件或超过 2 MiB；未自动处理。");
    return { text: await readFile(path, "utf8"), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { text: null, mode: 0o600 };
  }
}
function readJson(text: string | null, label: string): ObjectValue {
  try { return text === null ? {} : object(JSON.parse(text.replace(/^\uFEFF/, "")), label); }
  catch { throw new Error(`${label} 不是有效 JSON 对象；请先处理配置格式，未修改文件。`); }
}

/** Replace only the VibeGuard tables, then compare the ENTIRE parsed document.
 * Unusual inline forms are refused rather than reformatting other settings. */
export function mergeCodexMcp(text: string | null, entry: ObjectValue): string {
  const original = text?.replace(/^\uFEFF/, "") ?? "";
  let document: ObjectValue;
  try { document = parse(original, tomlOptions); }
  catch { throw new Error("Codex config.toml 不是可解析的 TOML；未修改文件。"); }
  const servers = document.mcp_servers === undefined ? {} : object(document.mcp_servers, "mcp_servers");
  const old = servers.vibeguard === undefined ? {} : object(servers.vibeguard, "vibeguard");
  if (old.url) throw new Error("已有 VibeGuard 使用远程地址；请明确移除或迁移该条目后再安装本地连接。");
  const envVars = old.env_vars ?? [];
  if (!Array.isArray(envVars)) throw new Error("已有 env_vars 格式无法合并；未修改文件。");
  const merged = { ...old, ...entry, env_vars: [...envVars.filter((value: unknown) => value !== "DEEPSEEK_API_KEY"), "DEEPSEEK_API_KEY"] };
  const normalizedEntry = parse(stringify({ entry: merged }, tomlWriteOptions), tomlOptions).entry;
  if (isDeepStrictEqual(old, normalizedEntry)) return text!;
  const expected = parse(original, tomlOptions);
  expected.mcp_servers = { ...servers, vibeguard: merged };
  const replacement = stringify({ mcp_servers: { vibeguard: merged } }, tomlWriteOptions).trimEnd() + "\n";
  const lines = original.split(/(?<=\n)/);
  const ranges: { start: number; end: number; own: boolean }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line.startsWith("[")) continue;
    try {
      const header = parse(`${line}\n__vibeguard_probe__ = true\n`, tomlOptions);
      const probe = (header.mcp_servers as ObjectValue | undefined)?.vibeguard;
      const hasProbe = (value: any): boolean => !!value && typeof value === "object" &&
        (value.__vibeguard_probe__ === true || Object.values(value).some(hasProbe));
      const own = hasProbe(probe);
      if (ranges.length) ranges.at(-1)!.end = index;
      ranges.push({ start: index, end: lines.length, own });
    } catch { /* Table-looking text inside strings is checked by the full round-trip below. */ }
  }
  let candidate: string;
  const own = ranges.filter(range => range.own);
  if (servers.vibeguard !== undefined && !own.length) throw new Error("已有 VibeGuard 使用内联 TOML；请改用标准表格式，向导不会重写其他设置。");
  if (own.length) {
    // Place replacement at EOF so a preceding parent table cannot capture later keys.
    const removed = new Set(own.flatMap(range => Array.from({ length: range.end - range.start }, (_, offset) => range.start + offset)));
    candidate = lines.filter((_, index) => !removed.has(index)).join("").trimEnd() + "\n\n" + replacement;
  } else candidate = original.trimEnd() + (original.trim() ? "\n\n" : "") + replacement;
  try {
    const normalizedExpected = parse(stringify(expected, tomlWriteOptions), tomlOptions);
    if (!isDeepStrictEqual(parse(candidate, tomlOptions), normalizedExpected)) throw new Error("changed");
  } catch { throw new Error("无法在保留其他 TOML 设置的前提下合并；未修改文件，请使用手动接入说明。"); }
  return candidate;
}

function mergeHooks(document: ObjectValue, group: ObjectValue): ObjectValue {
  const hooks = document.hooks === undefined ? {} : object(document.hooks, "hooks");
  const entries = hooks.PreToolUse ?? [];
  if (!Array.isArray(entries)) throw new Error("PreToolUse 不是列表；未修改文件。");
  let found = false;
  for (const item of entries) {
    if (item?.matcher !== group.matcher) continue;
    if (!Array.isArray(item.hooks)) throw new Error("已有同名采集规则格式无效；未修改文件。");
    for (const handler of item.hooks) {
      if (isDeepStrictEqual(handler, group.hooks[0])) found = true;
      else if (typeof handler.command === "string" && /[\\/]capture-hook-entry\.js/.test(handler.command)) {
        throw new Error("已有不同路径或参数的 VibeGuard 采集钩子；请先处理旧连接，避免重复采集或串用存储。");
      }
    }
  }
  return found ? document : { ...document, hooks: { ...hooks, PreToolUse: [...entries, group] } };
}

export async function prepareConnection(host: SupportedCollector, options: InstallOptions = {}): Promise<ConnectionInstallation> {
  const home = resolve(options.homeDir ?? homedir());
  const codexHome = resolve(!options.homeDir && process.env.CODEX_HOME ? process.env.CODEX_HOME : join(home, ".codex"));
  const claudeHome = resolve(!options.homeDir && process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR : join(home, ".claude"));
  const guide = buildConnectionConfig(host, options);
  const edits: Edit[] = [];
  const warnings: string[] = [];
  const add = async (path: string, purpose: string, merge: (text: string | null) => string) => {
    const before = await readConfig(path);
    const after = merge(before.text);
    if (after !== before.text) edits.push({ path, before: before.text, after, mode: before.mode, purpose });
  };
  if (host === "codex") {
    const entry = { command: guide.mcp.form.command, args: guide.mcp.form.args, env_vars: ["DEEPSEEK_API_KEY"] };
    await add(join(codexHome, "config.toml"), "接通 VibeGuard 工具", text => mergeCodexMcp(text, entry));
    await add(join(codexHome, "hooks.json"), "主动验收时采集当前对话", text => {
      const original = readJson(text, "Codex hooks.json");
      const updated = mergeHooks(original, guide.collector.hooksJson.hooks.PreToolUse[0]);
      return isDeepStrictEqual(original, updated) && text !== null ? text : JSON.stringify(updated, null, 2) + "\n";
    });
    warnings.push("Codex 中还需审查并信任新钩子；向导不会代替用户信任，也不会更改全局审批或沙箱。");
    warnings.push(guide.collector.approvalEffect);
  } else {
    const configPath = !options.homeDir && process.env.CLAUDE_CONFIG_DIR ? join(claudeHome, ".claude.json") : join(home, ".claude.json");
    await add(configPath, "接通当前用户的 VibeGuard 工具", text => {
      const original = readJson(text, "Claude 用户 MCP 配置");
      const servers = original.mcpServers === undefined ? {} : object(original.mcpServers, "mcpServers");
      const old = servers.vibeguard === undefined ? {} : object(servers.vibeguard, "vibeguard");
      if (old.url) throw new Error("已有 VibeGuard 为远程服务，请先处理该条目。");
      const merged = { ...old, ...guide.mcp.json.mcpServers.vibeguard, env: { ...(old.env ?? {}), ...guide.mcp.json.mcpServers.vibeguard.env } };
      if (isDeepStrictEqual(old, merged)) return text!;
      return JSON.stringify({ ...original, mcpServers: { ...servers, vibeguard: merged } }, null, 2) + "\n";
    });
    await add(join(claudeHome, "settings.json"), "主动验收时采集当前对话", text => {
      const original = readJson(text, "Claude settings.json");
      if (original.disableAllHooks === true) warnings.push("现有设置禁用了钩子；向导保留该设置，需要你在平台处理后才能采集。");
      const updated = mergeHooks(original, guide.collector.hooksJson.hooks.PreToolUse[0]);
      return isDeepStrictEqual(original, updated) && text !== null ? text : JSON.stringify(updated, null, 2) + "\n";
    });
    warnings.push("Claude Code 应用内端到端接入仍待实测，当前先验证配置合并与独立工具连接。");
  }
  return { host, guide, edits, warnings };
}

/** The preview deliberately contains no old config content or actual credentials. */
export function connectionPreview(plan: ConnectionInstallation): Record<string, unknown> {
  return { host: plan.host, scope: "user", mode: "manual", automaticVerification: false,
    changes: plan.edits.map(edit => ({ path: edit.path, purpose: edit.purpose, action: edit.before === null ? "create" : "merge", beforeSha256: edit.before === null ? null : sha256(edit.before), afterSha256: sha256(edit.after) })),
    dataDir: plan.guide.mcp.form.args.at(-1), credential: "只引用 DEEPSEEK_API_KEY 环境变量，不复制密钥值",
    collection: "仅在主动调用验收时读取平台提供的当前会话，不后台扫描全部聊天。原文将保存在本地；调用模型验收时会按任务范围发送必要内容。",
    mcp: plan.guide.mcp.form, collector: plan.guide.collector.hooksJson, warnings: plan.warnings };
}

/** Best-effort two-file transaction. No persistent config backup; rollback in memory. */
export async function applyConnection(plan: ConnectionInstallation): Promise<Record<string, unknown>> {
  const staged: { edit: Edit; temporary: string }[] = [];
  const committed: Edit[] = [];
  try {
    for (const edit of plan.edits) {
      if (!isAbsolute(edit.path)) throw new Error("Configuration target must be absolute");
      if ((await readConfig(edit.path)).text !== edit.before) throw new Error("配置在预览后发生变化，已停止；请重新生成预览。");
    }
    for (const edit of plan.edits) {
      await mkdir(dirname(edit.path), { recursive: true });
      await rejectLinks(edit.path);
      const temporary = join(dirname(edit.path), `.vibeguard-${randomUUID()}.tmp`);
      staged.push({ edit, temporary });
      await writeFile(temporary, edit.after, { flag: "wx", mode: edit.mode });
    }
    for (const item of staged) {
      if ((await readConfig(item.edit.path)).text !== item.edit.before) throw new Error("配置在写入前发生变化，已停止。");
      await rename(item.temporary, item.edit.path);
      committed.push(item.edit);
    }
    return { host: plan.host, status: "configuration_written", changedFiles: committed.map(edit => edit.path), requiresHostReload: true, hostCollectionVerified: false, warnings: plan.warnings };
  } catch (error) {
    let rollbackFailed = false;
    for (const edit of committed.reverse()) {
      try {
        if ((await readConfig(edit.path)).text !== edit.after) throw new Error("Concurrent edit");
        if (edit.before === null) await unlink(edit.path);
        else {
          const temporary = join(dirname(edit.path), `.vibeguard-${randomUUID()}.tmp`);
          staged.push({ edit, temporary });
          await writeFile(temporary, edit.before, { flag: "wx", mode: edit.mode });
          await rename(temporary, edit.path);
        }
      } catch { rollbackFailed = true; }
    }
    if (rollbackFailed) throw new Error("连接写入未完成，且部分配置无法回滚；请核对预览中的目标文件。未输出原配置或密钥。");
    throw error;
  } finally {
    for (const item of staged) {
      try { await unlink(item.temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
