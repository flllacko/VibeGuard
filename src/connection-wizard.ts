import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { prepareConnection, applyConnection, connectionPreview, type InstallOptions } from "./connection-install.js";
import { checkConnection } from "./connection-doctor.js";
import type { SupportedCollector } from "./capture-hook.js";

function hostValue(value: string | undefined): SupportedCollector | undefined {
  if (value === undefined) return undefined;
  if (value === "codex" || value === "claude-code") return value;
  throw new Error("当前向导支持 codex、claude-code；其他平台尚未提供自动配置适配器。");
}
export async function runConnectionWizard(hostInput: string | undefined, options: InstallOptions & { yes?: boolean; dryRun?: boolean; json?: boolean }) {
  const interactive = stdin.isTTY && stdout.isTTY;
  const terminal = interactive && !options.json ? createInterface({ input: stdin, output: stdout }) : undefined;
  try {
    let host = hostValue(hostInput);
    if (!host && terminal) {
      const selected = (await terminal.question("选择平台：1 Codex；2 Claude Code（应用内接入待实测）；0 退出\n> ")).trim();
      if (selected === "0") return;
      host = hostValue(selected === "1" ? "codex" : selected === "2" ? "claude-code" : selected);
    }
    if (!host) throw new Error("请指定平台：node dist/cli.js connect codex 或 connect claude-code。");
    const plan = await prepareConnection(host, options);
    const preview = connectionPreview(plan);
    if (!options.json) {
      console.log(`VibeGuard 接入向导｜${host}｜当前用户范围\n`);
      for (const edit of plan.edits) console.log(`- ${edit.before === null ? "创建" : "合并"} ${edit.path}\n  用途：${edit.purpose}`);
      if (!plan.edits.length) console.log("配置已与本包一致，无需重复写入。");
      console.log(`\n${preview.collection}\n${preview.credential}`);
      for (const warning of plan.warnings) console.log(`\n${warning}`);
    }
    if (options.dryRun || (!options.yes && !terminal)) {
      if (options.json) console.log(JSON.stringify(preview, null, 2));
      else console.log("\n当前只预览，未修改平台。交互运行时确认后安装；明确同意本次配置改动时也可使用 --yes。");
      return;
    }
    if (!options.yes && plan.edits.length && terminal) {
      const consent = (await terminal.question("\n是否应用以上连接配置？输入 y 确认，直接回车退出： ")).trim().toLowerCase();
      if (consent !== "y") { console.log("已退出，平台配置未修改。"); return; }
    }
    const installed = await applyConnection(plan);
    const doctor = await checkConnection(host, options);
    if (options.json) console.log(JSON.stringify({ preview, installed, doctor }, null, 2));
    else {
      console.log("\n配置处理完成，开始独立连接检查：");
      const symbols = { passed: "✅", pending: "⚠", failed: "❌" };
      for (const check of doctor.checks) console.log(`${symbols[check.status]} ${check.name}：${check.detail}`);
      console.log("\n回到平台重载服务并完成必要授权，再主动说“用 VibeGuard 验收”。自动验收默认关闭。");
    }
    if (doctor.status === "needs_fix") process.exitCode = 2;
  } finally { terminal?.close(); }
}
