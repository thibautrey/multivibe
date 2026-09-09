import { createServer, type ServerOptions } from "node:https";
import type { TLSSocket } from "node:tls";
import type { ManagedExecutor } from "./executor.js";
import type { ExecutionJournal } from "./journal.js";

/** Dedicated workload-only server: no desktop routes, account management or plugins. */
export function createManagedExecutionServer(options: {
  tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  allowedClientUri: string;
  allowedDiscoveryUri?: string;
  executor: Pick<ManagedExecutor, "execute">;
  journal: Pick<ExecutionJournal, "receipt">;
  discovery?: { read(): Promise<unknown> };
  maximumRequestBytes: number;
  maximumConcurrentExecutions: number;
}) {
  if (!options.allowedClientUri.startsWith("spiffe://") || !options.tls.key || !options.tls.cert || !options.tls.ca
    || !Number.isSafeInteger(options.maximumRequestBytes) || options.maximumRequestBytes <= 0
    || !Number.isSafeInteger(options.maximumConcurrentExecutions) || options.maximumConcurrentExecutions <= 0) throw Error("invalid_managed_server_configuration");
  if (options.allowedDiscoveryUri !== undefined && !options.allowedDiscoveryUri.startsWith("spiffe://")) throw Error("invalid_discovery_identity");
  let active = 0;
  const server = createServer({ ...options.tls, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" }, async (req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    const fail = (status: number, code: string) => { res.statusCode = status; res.end(JSON.stringify({ error: { code } })); };
    const socket = req.socket as TLSSocket;
    const san = socket.getPeerCertificate().subjectaltname?.split(", ") ?? [];
    const executionWorkload = san.includes(`URI:${options.allowedClientUri}`);
    const discoveryOnly = req.method === "GET" && req.url === "/internal/v1/providers/discovery"
      && options.allowedDiscoveryUri !== undefined && san.includes(`URI:${options.allowedDiscoveryUri}`);
    if (!socket.authorized || (!executionWorkload && !discoveryOnly)) { fail(403, "workload_forbidden"); return; }
    if (req.method === "GET" && req.url === "/internal/v1/providers/discovery" && options.discovery) {
      try { res.end(JSON.stringify(await options.discovery.read())); }
      catch { fail(503, "provider_discovery_unavailable"); }
      return;
    }
    if (req.method === "GET" && req.url === "/health/live") { res.end('{"ok":true}'); return; }
    if (req.method === "GET" && /^\/internal\/v1\/receipts\/[a-zA-Z0-9._-]{1,256}$/.test(req.url ?? "")) {
      try {
        const receipt = await options.journal.receipt(req.url!.split("/").at(-1)!);
        if (!receipt) { fail(404, "receipt_unavailable"); return; }
        res.end(JSON.stringify(receipt));
      } catch { fail(503, "receipt_unavailable"); }
      return;
    }
    if (req.method !== "POST" || req.url !== "/internal/v1/execute") { fail(404, "not_found"); return; }
    if (active >= options.maximumConcurrentExecutions) { fail(503, "executor_busy"); return; }
    const token = req.headers["x-multivibe-execution-grant"];
    if (typeof token !== "string" || token.length > 8192) { fail(403, "execution_grant_required"); return; }
    if (req.headers["content-type"] !== "application/json" || req.headers["content-encoding"]) { fail(415, "unsupported_body"); return; }
    active++;
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        length += bytes.byteLength;
        if (length > options.maximumRequestBytes) { fail(413, "request_too_large"); return; }
        chunks.push(bytes);
      }
      // Once accepted, execution/receipt persistence survives the caller disconnecting.
      const result = await options.executor.execute(token, Buffer.concat(chunks));
      if (result.response.headers.get("content-type") === "text/event-stream" && result.response.body) {
        res.setHeader("content-type", "application/x-ndjson");
        res.write(JSON.stringify({ type: "response", status: result.response.status, contentType: "text/event-stream" }) + "\n");
        const reader = result.response.body.getReader();
        let disconnected = res.destroyed;
        res.once("close", () => { disconnected = true; void reader.cancel().catch(() => undefined); });
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            if (!disconnected && !res.write(JSON.stringify({ type: "chunk", bodyBase64: Buffer.from(next.value).toString("base64") }) + "\n")) {
              await new Promise<void>(resolve => {
                const finish = () => { res.off("drain", finish); res.off("close", finish); resolve(); };
                res.once("drain", finish); res.once("close", finish);
              });
            }
          }
        } catch { /* Persisted receipt remains the authority when streaming fails. */ }
        finally { reader.releaseLock(); }
        const receipt = await result.receipt;
        if (!disconnected) res.end(JSON.stringify({ type: "receipt", receipt }) + "\n");
        return;
      }
      const responseBody = Buffer.from(await result.response.arrayBuffer()).toString("base64");
      res.end(JSON.stringify({ receipt: await result.receipt, response: {
        status: result.response.status, contentType: result.response.headers.get("content-type"), bodyBase64: responseBody,
      } }));
    } catch { fail(502, "execution_unavailable"); }
    finally { active--; }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  return server;
}
