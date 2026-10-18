import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { ConversationSchema, type Conversation } from "./intake.js";
import { saveHostSnapshot } from "./host-snapshot.js";

const ThreadIdSchema = z.string().uuid();
const ItemSchema = z.object({ id: z.string().min(1), type: z.string().min(1) }).passthrough();
const TurnSchema = z.object({ id: z.string().min(1), itemsView: z.literal("full"), status: z.string(), items: z.array(ItemSchema) }).passthrough();
const ThreadSchema = z.object({ id: ThreadIdSchema, turns: z.array(TurnSchema) }).passthrough();
const PageSchema = z.object({ data: z.array(TurnSchema), nextCursor: z.string().nullable() }).passthrough();
type Turn = z.infer<typeof TurnSchema>;

export interface CodexHistoryReader {
  readThread(threadId: string): Promise<unknown>;
  listTurns(threadId: string, cursor: string | null): Promise<unknown>;
}

/** Only read methods are exposed; this client never resumes or starts a turn. */
export class CodexReadClient implements CodexHistoryReader {
  private process: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private lines;
  private closed = false;
  private ended = false;

  constructor(command = "codex") {
    this.process = spawn(command, ["app-server", "--stdio"], { stdio: "pipe", windowsHide: true });
    this.lines = createInterface({ input: this.process.stdout });
    this.process.stderr.on("data", () => { /* Diagnostics can contain private config; do not print them. */ });
    this.lines.on("line", line => {
      if (Buffer.byteLength(line) > 50 * 1024 * 1024) { this.fail(new Error("Codex response exceeds 50 MiB; history was not silently truncated")); return; }
      let message: { id?: number; result?: unknown; error?: { code?: number; message?: string } };
      try { message = JSON.parse(line); } catch { this.fail(new Error("Invalid Codex App Server response")); return; }
      if (message.id === undefined) return;
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(`Codex read request failed (${message.error.code ?? "unknown"}): ${message.error.message ?? "unknown error"}`));
      else waiting.resolve(message.result);
    });
    this.process.on("error", error => { this.ended = true; this.fail(error); });
    this.process.on("exit", () => { this.ended = true; this.fail(new Error("Codex read process exited")); });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "vibeguard_history_reader", title: "VibeGuard History Reader", version: "0.0.1" }, capabilities: { experimentalApi: true } });
    this.process.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  }

  async readThread(threadId: string): Promise<unknown> {
    ThreadIdSchema.parse(threadId);
    // Avoid returning the entire transcript twice. Large real conversations can
    // time out on includeTurns=true before paginated reading even begins.
    const metadata = z.object({ thread: z.object({ id: ThreadIdSchema }).passthrough() }).passthrough().parse(
      await this.request("thread/read", { threadId, includeTurns: false }),
    );
    if (metadata.thread.id !== threadId) throw new Error("Codex returned a different thread");
    const latest = await this.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "full", cursor: null });
    const page = PageSchema.parse(latest);
    return { thread: { ...metadata.thread, turns: page.data }, readResponses: { metadata, latest } };
  }

  listTurns(threadId: string, cursor: string | null): Promise<unknown> {
    return this.request("thread/turns/list", { threadId: ThreadIdSchema.parse(threadId), limit: 20, sortDirection: "asc", itemsView: "full", cursor });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("Codex read connection closed"));
    this.lines.close();
    this.process.stdin.end();
    await new Promise<void>(resolve => {
      if (this.ended || this.process.exitCode !== null || this.process.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { this.process.kill(); resolve(); }, 500);
      this.process.once("exit", () => { clearTimeout(timer); resolve(); });
      this.process.once("error", () => { clearTimeout(timer); resolve(); });
    });
  }

  private request(method: "initialize" | "thread/read" | "thread/turns/list", params: unknown): Promise<unknown> {
    if (this.closed || this.process.exitCode !== null || this.process.signalCode !== null) return Promise.reject(new Error("Codex read process is unavailable"));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex read timed out: ${method}`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => {
        if (!error) return;
        this.pending.delete(id); clearTimeout(timer); reject(error);
      });
    });
  }

  private fail(error: Error): void {
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    this.pending.clear();
  }
}

export async function readCodexHistory(reader: CodexHistoryReader, threadId: string): Promise<{ conversation: Conversation; receipt: Record<string, unknown>; raw: unknown }> {
  ThreadIdSchema.parse(threadId);
  const initial = z.object({ thread: ThreadSchema }).passthrough().parse(await reader.readThread(threadId));
  if (initial.thread.id !== threadId) throw new Error("Codex returned a different thread");
  const initialUsers = initial.thread.turns.flatMap(turn => turn.items).filter(item => item.type === "userMessage");
  let cutoff = initialUsers.at(-1)?.id;
  const initialLatestTurnId = initial.thread.turns.at(-1)?.id;
  if (!initialLatestTurnId) throw new Error("Codex thread has no known turn boundary");
  const pages: unknown[] = [];
  const turns: Turn[] = [];
  const seenTurns = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const rawPage = await reader.listTurns(threadId, cursor);
    const page = PageSchema.parse(rawPage);
    pages.push(rawPage);
    for (const turn of page.data) {
      if (seenTurns.has(turn.id)) throw new Error("Codex history repeated a turn across pages; capture stopped");
      seenTurns.add(turn.id); turns.push(turn);
    }
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (seenCursors.has(cursor) || pages.length >= 200) throw new Error("Codex pagination did not complete; capture stopped");
      seenCursors.add(cursor);
    }
  } while (cursor !== null);
  for (const turn of initial.thread.turns) {
    if (!seenTurns.has(turn.id)) throw new Error("A known Codex turn is missing from paginated history");
  }
  // A host-dispatched tool event or an assistant-only continuation can be the
  // latest turn. Find the original user before that pinned turn; never adopt a
  // user message appended AFTER capture began or relabel tool data as a user.
  const cutoffSelection = cutoff ? "user_in_initial_turn" : "user_before_initial_turn";
  if (!cutoff) {
    const boundary = turns.findIndex(turn => turn.id === initialLatestTurnId);
    cutoff = turns.slice(0, boundary + 1).flatMap(turn => turn.items).findLast(item => item.type === "userMessage")?.id;
  }
  if (!cutoff) throw new Error("Codex thread has no original user message before the known turn boundary");
  const messages: Conversation["messages"] = [];
  const seenMessages = new Set<string>();
  let reachedCutoff = false;
  let nonTextUserParts = 0;
  const unparsedUserContent: { messageId: string; count: number }[] = [];
  outer: for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type !== "userMessage" && item.type !== "agentMessage") continue;
      if (seenMessages.has(item.id)) throw new Error("Duplicate Codex message ID");
      seenMessages.add(item.id);
      let text: string;
      if (item.type === "userMessage") {
        const content = z.array(z.object({ type: z.string() }).passthrough()).parse(item.content);
        const count = content.filter(part => part.type !== "text").length;
        nonTextUserParts += count;
        if (count) unparsedUserContent.push({ messageId: item.id, count });
        text = content.filter(part => part.type === "text").map(part => z.string().parse(part.text)).join("\n");
      } else text = z.string().parse(item.text);
      messages.push({ id: item.id, sequence: messages.length + 1, role: item.type === "userMessage" ? "user" : "assistant", text });
      if (item.id === cutoff) { reachedCutoff = true; break outer; }
    }
  }
  if (!reachedCutoff) throw new Error("Latest known user message is missing from paginated history");
  for (const user of initialUsers) {
    const message = messages.find(item => item.id === user.id);
    if (!message) throw new Error("A known original user message is missing");
    const expected = z.array(z.object({ type: z.string() }).passthrough()).parse(user.content).filter(part => part.type === "text").map(part => z.string().parse(part.text)).join("\n");
    if (message.text !== expected) throw new Error("Original user text changed during capture");
  }
  const warnings = ["已读完宿主返回的历史页，但尚未确认具体业务任务的起止范围；本记录是会话材料快照，不代表任务已完成。"];
  if (cutoffSelection === "user_before_initial_turn") warnings.push("最新已知轮次只有工具或助手事件，已向前定位原始用户消息；工具事件没有改标为用户要求。");
  if (nonTextUserParts) warnings.push(`存在 ${nonTextUserParts} 个非文字用户内容；原始响应已保留，尚未解析这些内容。`);
  const conversation = ConversationSchema.parse({
    schemaVersion: 1, taskId: `codex-history-${threadId}`, sessionId: threadId, host: "codex-app-server",
    taskBoundary: { startMessageId: messages[0]!.id, endMessageId: cutoff },
    transcriptCoverage: { level: "partial", source: "host_adapter", basis: warnings.join(" "), missingMessageIds: [] }, messages,
    hostCapture: { allReturnedPagesRead: true, scopeOnlyGap: true, unparsedUserContent },
  });
  return {
    conversation,
    receipt: { threadId, pageCount: pages.length, allPagesRead: true, turnCount: turns.length, userMessageCount: messages.filter(item => item.role === "user").length, assistantMessageCount: messages.filter(item => item.role === "assistant").length, cutoffUserMessageId: cutoff, initialLatestTurnId, cutoffSelection, taskScopeConfirmed: false, transcriptCoverage: "partial", warnings },
    raw: { initial, pages },
  };
}

export async function captureCodexTask(dataDir: string, threadId: string, scope: "final" | "checkpoint" = "checkpoint", command = "codex"): Promise<Record<string, unknown>> {
  const client = new CodexReadClient(command);
  try {
    await client.initialize();
    const capture = await readCodexHistory(client, threadId);
    return await saveHostSnapshot(dataDir, "codex", capture, scope);
  } finally { await client.close(); }
}
