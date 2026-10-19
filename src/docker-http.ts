import { z } from "zod";
import { commandSucceeded, type DockerCommandOptions, type DockerCommandResult } from "./docker-client.js";
import type { HttpTransport } from "./plan-runner.js";

// Only this fixed collector executes. Request JSON is data, never model-authored code.
export const HTTP_COLLECTOR = `const http=require('node:http');const x=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));let done=false;const finish=v=>{if(done)return;done=true;process.stdout.write(JSON.stringify(v)+'\\n')};const body=x.body===undefined?undefined:JSON.stringify(x.body);const req=http.request({hostname:'127.0.0.1',port:x.port,path:x.path,method:x.method,headers:body===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{let bytes=0;const chunks=[];res.on('data',c=>{bytes+=c.length;if(bytes>65536){finish({status:res.statusCode,error:'BODY_LIMIT'});res.destroy();return}chunks.push(c)});res.on('end',()=>finish({status:res.statusCode,bodyBase64:Buffer.concat(chunks).toString('base64'),bodyBytes:bytes}));res.on('error',()=>finish({error:'RESPONSE_ERROR'}))});const timer=setTimeout(()=>{finish({error:'REQUEST_TIMEOUT'});req.destroy()},x.timeoutMs);req.on('close',()=>clearTimeout(timer));req.on('error',e=>finish({error:e.code||'REQUEST_ERROR'}));if(body!==undefined)req.write(body);req.end();`;

export const HttpCaptureSchema = z.object({ status: z.number().int().min(100).max(599).optional(),
  bodyBase64: z.string().max(87384).optional(), bodyBytes: z.number().int().min(0).max(65536).optional(), error: z.string().min(1).max(100).optional(),
}).strict();

export function dockerHttpTransport(session: { runId: string; containerId: string; port: number;
  invoke(args: string[], options: DockerCommandOptions): Promise<{ result: DockerCommandResult; eventIndex: number }> }): HttpTransport {
  return async (request, timeoutMs, signal) => {
    if (!/^[a-f0-9]{64}$/.test(session.containerId) || !z.string().uuid().safeParse(session.runId).success) throw new Error("Invalid runtime identity");
    if (!["GET", "POST"].includes(request.method) || !request.path.startsWith("/") || request.path.startsWith("//") || /[\\\x00-\x20#]/.test(request.path)) throw new Error("Invalid local HTTP request");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Invalid HTTP time bound");
    const input = JSON.stringify({ ...request, port: session.port, timeoutMs });
    if (Buffer.byteLength(input) > 8192) throw new Error("HTTP request exceeds 8 KiB");
    const { result, eventIndex } = await session.invoke(["exec", "--workdir", "/", "--env", "NODE_OPTIONS=", "--env", "NODE_PATH=", session.containerId,
      "/usr/local/bin/node", "--input-type=commonjs", "-e", HTTP_COLLECTOR, Buffer.from(input).toString("base64")],
      { timeoutMs: Math.min(61000, timeoutMs + 1000), maxOutputBytes: 128 * 1024, signal });
    const observation = { runtimeRunId: session.runId, eventIndex };
    if (!commandSucceeded(result)) return { observation, error: `Docker HTTP collector failed: exit=${result.exitCode}, timeout=${result.timedOut}, aborted=${result.aborted}, truncated=${result.outputTruncated}, code=${result.errorCode ?? "none"}` };
    let captured: z.infer<typeof HttpCaptureSchema>;
    try { captured = HttpCaptureSchema.parse(JSON.parse(result.stdout)); } catch { return { observation, error: "Docker HTTP collector returned an invalid record" }; }
    const receipt = { ...observation, ...(captured.bodyBase64 !== undefined ? { bodyBase64: captured.bodyBase64, bodyBytes: captured.bodyBytes } : {}) };
    if (captured.error) return { observation: receipt, error: captured.error };
    if (captured.status === undefined || captured.bodyBase64 === undefined || captured.bodyBytes === undefined) return { observation: receipt, error: "HTTP observation incomplete" };
    const bytes = Buffer.from(captured.bodyBase64, "base64");
    if (bytes.length !== captured.bodyBytes || bytes.toString("base64") !== captured.bodyBase64) return { observation: receipt, error: "HTTP response byte accounting mismatch" };
    const text = bytes.toString("utf8"); let body: unknown; try { body = JSON.parse(text); } catch { body = text; }
    return { observation: receipt, response: { status: captured.status, body } };
  };
}
