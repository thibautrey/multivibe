import type { KeyObject } from "node:crypto";
import { createHash } from "node:crypto";
import { verifyExecutionGrant, type ExecutionGrant } from "./authorization.js";
import type { ExecutionReceipt } from "./journal.js";
import type { ExecutionOwnership } from "./coordination-client.js";
import { managedProviderStream } from "./stream.js";
import { providerTokenUsage } from "./usage.js";
import { managedProviderRequest } from "./request.js";
import { chatCompletionObjectToResponseObject } from "../responses/converters.js";
import {encryptExecutionResponse, type ExecutionRecoveryEnvelope} from "./response-recovery.js";

/** Forward only in memory over the private authenticated injector corridor. */
export interface ManagedInvocationAuthorization {
  readonly token: string;
  readonly originalBody: Uint8Array;
  readonly ownership: ExecutionOwnership;
  /** Injector-local callback, never serialized or accepted from the HTTP caller.
   * Recheck dispatch authority after asynchronous credential access. */
  readonly beforeDispatch?: () => Promise<void>;
}
export interface ManagedProviderAccount {
  providerId: string;
  credentialRef: string;
  models: ReadonlySet<string>;
  /** Deployment-owned connector. It resolves credentials and enforces provider TLS/egress.
   * This function must issue one request only; never install Core's desktop retry router. */
  chatCompletions(body: Uint8Array, signal: AbortSignal, authorization: ManagedInvocationAuthorization): Promise<Response>;
}
export interface ManagedExecutionResult { response: Response; receipt: ExecutionReceipt | Promise<ExecutionReceipt> }
export class ManagedExecutor {
  constructor(private readonly dependencies: {
    verificationKey: KeyObject;
    accounts: readonly ManagedProviderAccount[];
    coordination: {claim(token: string): Promise<ExecutionOwnership>};
    receiptWriter: {finish(token: string, ownership: ExecutionOwnership, receipt: ExecutionReceipt,
      recovery?:ExecutionRecoveryEnvelope): Promise<void>};
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
    const bytes = managedProviderRequest(grant, body);
    const ownership = await this.dependencies.coordination.claim(token);
    const receipt = this.baseReceipt(grant, now());
    let response: Response;
    try {
      const upstreamResponse = await accounts[0].chatCompletions(bytes, AbortSignal.timeout(this.dependencies.executionTimeoutMs),
        { token, originalBody: new Uint8Array(body), ownership });
      receipt.status = upstreamResponse.status;
      if (grant.stream && upstreamResponse.ok && upstreamResponse.body
        && upstreamResponse.headers.get("content-type")?.startsWith("text/event-stream")) {
        return managedProviderStream({ response: upstreamResponse, grant, receipt,
          maximumBytes: this.dependencies.maximumResponseBytes,
          finish: (value,recovery) => this.dependencies.receiptWriter.finish(token, ownership, value,recovery), clock: now });
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
      const usage = providerTokenUsage(payload, grant.maximumOutputTokens);
      receipt.usage = usage ? { ...usage } : null;
      // Provider errors may report consumption, but cannot authorize automatic settlement.
      receipt.state = upstreamResponse.ok && usage ? "completed" : "uncertain";
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
    let recovery:ExecutionRecoveryEnvelope|undefined;
    if(receipt.state==="completed"){
      const contentType=response.headers.get("content-type");
      if(contentType!=="application/json"&&contentType!=="application/json; charset=utf-8")throw Error("invalid_recovery_content_type");
      const recoveryBody=new Uint8Array(await response.clone().arrayBuffer());
      if(recoveryBody.byteLength>this.dependencies.maximumResponseBytes){
        receipt.state="uncertain";
        response=Response.json({error:{code:"provider_execution_uncertain"}},{status:502});
      }else recovery=encryptExecutionResponse(grant,response.status,contentType,recoveryBody);
    }
    await this.dependencies.receiptWriter.finish(token, ownership, receipt,recovery);
    return { response, receipt };
  }
  private baseReceipt(grant: ExecutionGrant, at: number): ExecutionReceipt {
    return { version: 1, attemptId: grant.attemptId, reservationId: grant.reservationId,
      routeVersionId: grant.routeVersionId, providerId: grant.providerId, bodySha256: grant.bodySha256,
      state: "uncertain", usage: null, responseSha256: null, status: null, finishedAt: at };
  }
}
