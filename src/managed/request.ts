import type { ExecutionGrant } from "./authorization.js";
import { responsesToChatCompletionsPayload } from "../responses/payloads.js";

/** Pure provider projection shared by Core and the separate credential injector. */
export function managedProviderRequest(grant: Readonly<ExecutionGrant>, body: Uint8Array): Uint8Array {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || ![grant.model, grant.upstreamModel].includes(parsed.model)
      || (parsed.stream ?? false) !== grant.stream) throw Error("execution_payload_mismatch");
    // max_tokens is a per-choice limit. Multiple choices would multiply the
    // spend behind a grant that authorizes only one bounded output.
    if (parsed.n !== undefined && parsed.n !== 1) throw Error("execution_single_output_required");
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
    return Buffer.from(JSON.stringify(upstream));
}
