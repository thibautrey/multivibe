import {randomUUID} from "node:crypto";
import {request} from "node:https";
import type {ExecutionReceipt} from "./journal.js";

export interface ExecutionOwnership {readonly ownerId: string; readonly epoch: number}

export function validateExecutionOwnership(value: unknown): ExecutionOwnership {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid_execution_ownership");
  const ownership = value as ExecutionOwnership;
  if (Object.keys(ownership).sort().join() !== "epoch,ownerId"
    || typeof ownership.ownerId !== "string"
    || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(ownership.ownerId)
    || !Number.isSafeInteger(ownership.epoch) || ownership.epoch < 1) throw Error("invalid_execution_ownership");
  return Object.freeze({ownerId: ownership.ownerId, epoch: ownership.epoch});
}

/** Workload-specific client for the private coordination service. It carries
 * signed execution metadata only; prompts and provider credentials never cross
 * this boundary. A rejected/lost dispatch acknowledgement never gets retried. */
export class ManagedCoordinationClient {
  private readonly base: URL;
  constructor(baseUrl: string, private readonly tls: {ca: Buffer; cert: Buffer; key: Buffer},
    private readonly timeoutMs: number, private readonly leaseMs = 30000) {
    this.base = new URL(baseUrl);
    if (this.base.protocol !== "https:" || this.base.username || this.base.password || this.base.pathname !== "/"
      || this.base.search || this.base.hash || !tls.ca.length || !tls.cert.length || !tls.key.length
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || !Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 30000) {
      throw Error("invalid_coordination_client");
    }
  }
  async claim(token: string): Promise<ExecutionOwnership> {
    return validateExecutionOwnership(await this.post("claim", token, {ownerId: randomUUID(), leaseMs: this.leaseMs}));
  }
  async dispatch(token: string, ownership: ExecutionOwnership): Promise<void> {
    validateExecutionOwnership(ownership);
    const result = await this.post("dispatch", token, {ownership});
    if (!result || typeof result !== "object" || Array.isArray(result)
      || Object.keys(result).join() !== "ok" || (result as {ok?: unknown}).ok !== true) throw Error("coordination_invalid_response");
  }
  async finish(token: string, ownership: ExecutionOwnership, receipt: ExecutionReceipt): Promise<void> {
    validateExecutionOwnership(ownership);
    const result = await this.post("finish", token, {ownership, receipt});
    if (!result || typeof result !== "object" || Array.isArray(result)
      || Object.keys(result).join() !== "ok" || (result as {ok?: unknown}).ok !== true) throw Error("coordination_invalid_response");
  }
  private post(action: "claim" | "dispatch" | "finish", token: string, body: unknown): Promise<unknown> {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 8192) throw Error("invalid_coordination_grant");
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > 16384) throw Error("coordination_request_too_large");
    return new Promise((resolve, reject) => {
      const req = request(new URL(`/internal/v1/coordination/${action}`, this.base), {
        ...this.tls, method: "POST", minVersion: "TLSv1.3", rejectUnauthorized: true,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {"content-type": "application/json", "content-length": Buffer.byteLength(payload),
          "x-multivibe-execution-grant": token},
      }, response => {
        const chunks: Buffer[] = []; let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 16384) response.destroy(Error("coordination_response_too_large"));
          else chunks.push(chunk);
        });
        response.on("error", () => reject(Error("coordination_response_unavailable")));
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(Error("coordination_operation_rejected")); return;
          }
          try {resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));}
          catch {reject(Error("coordination_invalid_response"));}
        });
      });
      req.on("error", () => reject(Error("coordination_connection_unavailable")));
      req.end(payload);
    });
  }
}
