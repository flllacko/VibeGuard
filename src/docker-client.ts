import { spawn } from "node:child_process";
import { createReadStream, type ReadStream } from "node:fs";

export interface DockerCommandResult {
  exitCode: number | null; signal: string | null; stdout: string; stderr: string;
  timedOut: boolean; aborted: boolean; outputTruncated: boolean; errorCode?: string; durationMs: number;
}
export interface DockerCommandOptions { timeoutMs?: number; signal?: AbortSignal; inputFile?: string; maxOutputBytes?: number }
export interface DockerClient { invoke(args: string[], options?: DockerCommandOptions): Promise<DockerCommandResult> }
export const commandSucceeded = (result: DockerCommandResult): boolean => result.exitCode === 0 && !result.timedOut && !result.aborted && !result.outputTruncated && !result.errorCode;

/** No shell, interpolated script, host secret forwarding or implicit Docker pull. */
export class DockerCli implements DockerClient {
  constructor(private executable = "docker") {}
  async invoke(args: string[], options: DockerCommandOptions = {}): Promise<DockerCommandResult> {
    const started = Date.now();
    const empty: DockerCommandResult = { exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, outputTruncated: false, durationMs: 0 };
    if (options.signal?.aborted) return { ...empty, aborted: true };
    const timeoutMs = options.timeoutMs ?? 10000, limit = options.maxOutputBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1024 * 1024) throw new Error("Invalid Docker command bounds");
    return new Promise(resolve => {
      const result = { ...empty }, stdout: Buffer[] = [], stderr: Buffer[] = [];
      const child = spawn(this.executable, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let bytes = 0, input: ReadStream | undefined;
      const stop = () => { input?.destroy(); child.stdin.destroy(); child.kill(); };
      const timer = setTimeout(() => { result.timedOut = true; stop(); }, timeoutMs);
      const abort = () => { result.aborted = true; stop(); };
      options.signal?.addEventListener("abort", abort, { once: true });
      const collect = (destination: Buffer[]) => (value: Buffer) => {
        const available = Math.max(0, limit - bytes);
        if (available) destination.push(value.subarray(0, available));
        bytes += value.length;
        if (bytes > limit) { result.outputTruncated = true; stop(); }
      };
      child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
      child.on("error", error => { result.errorCode = (error as NodeJS.ErrnoException).code ?? "SPAWN_ERROR"; });
      // EPIPE after a failed docker cp is an invocation failure, never an uncaught exception.
      child.stdin.on("error", () => { result.errorCode ??= "STDIN_ERROR"; stop(); });
      if (options.inputFile) {
        input = createReadStream(options.inputFile);
        input.on("error", () => { result.errorCode = "INPUT_FILE_ERROR"; stop(); });
        input.pipe(child.stdin);
      } else child.stdin.end();
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer); options.signal?.removeEventListener("abort", abort); input?.destroy();
        resolve({ ...result, exitCode, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), durationMs: Date.now() - started });
      });
      if (options.signal?.aborted) abort();
    });
  }
}
