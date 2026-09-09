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
    const outputLimits = [parsed.max_output_tokens, parsed.max_completion_tokens, parsed.max_tokens]
      .filter(value => value !== undefined);
    if (outputLimits.some(value => !Number.isSafeInteger(value) || value <= 0
      || value > grant.maximumOutputTokens || value !== outputLimits[0])) {
      throw Error("execution_output_limit_mismatch");
    }
    const outputLimit = outputLimits[0] ?? grant.maximumOutputTokens;
    const upstream = grant.operation === "responses" ? responsesToChatCompletionsPayload(parsed) : { ...parsed };
    upstream.model = grant.upstreamModel;
    upstream.stream = grant.stream;
    if (grant.stream) upstream.stream_options = { include_usage: true };
    delete upstream.max_output_tokens;
    delete upstream.max_completion_tokens;
    delete upstream.max_tokens;
    // OpenAI's completion bound includes hidden reasoning tokens; max_tokens
    // is deprecated and rejected by o-series models. Other compatible
    // providers retain their existing certified parameter.
    upstream[grant.providerId === "openai" ? "max_completion_tokens" : "max_tokens"] = outputLimit;
    return Buffer.from(JSON.stringify(upstream));
}
