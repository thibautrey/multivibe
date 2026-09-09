import type { KeyObject } from "node:crypto";
import { createHash } from "node:crypto";
import { verifyExecutionGrant, type ExecutionGrant } from "./authorization.js";
import { type ExecutionJournal, type ExecutionReceipt } from "./journal.js";
import { managedProviderStream } from "./stream.js";
import { providerTokenUsage } from "./usage.js";
import { responsesToChatCompletionsPayload } from "../responses/payloads.js";
import { chatCompletionObjectToResponseObject } from "../responses/converters.js";

export interface ManagedProviderAccount {
  providerId: string;
  credentialRef: string;
  models: ReadonlySet<string>;
  /** Deployment-owned connector. It resolves credentials and enforces provider TLS/egress.
   * This function must issue one request only; never install Core's desktop retry router. */
  chatCompletions(body: Uint8Array, signal: AbortSignal): Promise<Response>;
}
export interface ManagedExecutionResult { response: Response; receipt: ExecutionReceipt | Promise<ExecutionReceipt> }
export class ManagedExecutor {
  constructor(private readonly dependencies: {
    verificationKey: KeyObject;
    accounts: readonly ManagedProviderAccount[];
    journal: Pick<ExecutionJournal, "claim" | "finish">;
    maximumRequestBytes: number;
    maximumResponseBytes: number;
    executionTimeoutMs: number;
    clock?: () => number;
  }) {
    for (const value of [dependencies.maximumRequestBytes, dependencies.maximumResponseBytes, dependencies.executionTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw Error("invalid_executor_limit");
    }
  }
  async execute(token: string, body: Uint8Array): Promise<ManagedExecutionResult> {
    const now = this.dependencies.clock ?? Date.now;
    if (body.byteLength > this.dependencies.maximumRequestBytes) throw Error("execution_request_too_large");
    const grant = verifyExecutionGrant(token, body, this.dependencies.verificationKey, now());
    const accounts = this.dependencies.accounts.filter(account => account.providerId === grant.providerId
      && account.credentialRef === grant.credentialRef && account.models.has(grant.upstreamModel));
    if (accounts.length !== 1) throw Error("execution_account_unavailable");
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || ![grant.model, grant.upstreamModel].includes(parsed.model)
      || (parsed.stream ?? false) !== grant.stream) throw Error("execution_payload_mismatch");
    const outputLimit = parsed.max_output_tokens ?? parsed.max_completion_tokens ?? parsed.max_tokens;
    if (outputLimit !== undefined && (!Number.isSafeInteger(outputLimit) || outputLimit <= 0
      || outputLimit > grant.maximumOutputTokens)) throw Error("execution_output_limit_mismatch");
    const upstream = grant.operation === "responses" ? responsesToChatCompletionsPayload(parsed) : { ...parsed };
    upstream.model = grant.upstreamModel;
    upstream.stream = grant.stream;
    if (grant.stream) upstream.stream_options = { include_usage: true };
    delete upstream.max_output_tokens;
    delete upstream.max_completion_tokens;
    upstream.max_tokens = outputLimit ?? grant.maximumOutputTokens;
    // Complete conversion and serialization before the irreversible attempt fence.
    const bytes = Buffer.from(JSON.stringify(upstream));
    await this.dependencies.journal.claim(grant);
    const receipt = this.baseReceipt(grant, now());
    let response: Response;
    try {
      const upstreamResponse = await accounts[0].chatCompletions(bytes, AbortSignal.timeout(this.dependencies.executionTimeoutMs));
      receipt.status = upstreamResponse.status;
      if (grant.stream && upstreamResponse.ok && upstreamResponse.body
        && upstreamResponse.headers.get("content-type")?.startsWith("text/event-stream")) {
        return managedProviderStream({ response: upstreamResponse, grant, receipt,
          maximumBytes: this.dependencies.maximumResponseBytes,
          finish: value => this.dependencies.journal.finish(value), clock: now });
      }
      const reader = upstreamResponse.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      const hash = createHash("sha256");
      if (reader) {
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > this.dependencies.maximumResponseBytes) throw Error("execution_response_too_large");
            hash.update(next.value);
            chunks.push(next.value);
          }
        } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
        finally { reader.releaseLock(); }
      }
      receipt.responseSha256 = hash.digest("hex");
      const raw = Buffer.concat(chunks);
      let payload: unknown;
      try { payload = JSON.parse(raw.toString("utf8")); } catch { payload = undefined; }
      const usage = providerTokenUsage(payload);
      receipt.usage = usage ? { ...usage } : null;
      // A completed HTTP response without usage is still financially uncertain.
      receipt.state = usage ? "completed" : "uncertain";
      if (!upstreamResponse.ok) {
        // Provider error bodies and headers can contain credentials or internal account data.
        response = Response.json({ error: { code: "provider_execution_failed" } }, { status: 502 });
      } else if (grant.operation === "responses") {
        if (!payload || typeof payload !== "object") throw Error("execution_response_invalid");
        const converted = chatCompletionObjectToResponseObject(payload, grant.model);
        converted.model = grant.model;
        response = Response.json(converted);
      } else {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw Error("execution_response_invalid");
        response = Response.json({ ...payload, model: grant.model });
      }
    } catch {
      response = Response.json({ error: { code: "provider_execution_uncertain" } }, { status: 502 });
    }
    receipt.finishedAt = now();
    // If persistence fails, do not claim success or authorize a retry.
    await this.dependencies.journal.finish(receipt);
    return { response, receipt };
  }
  private baseReceipt(grant: ExecutionGrant, at: number): ExecutionReceipt {
    return { version: 1, attemptId: grant.attemptId, reservationId: grant.reservationId,
      routeVersionId: grant.routeVersionId, providerId: grant.providerId, bodySha256: grant.bodySha256,
      state: "uncertain", usage: null, responseSha256: null, status: null, finishedAt: at };
  }
}
