/** Billing evidence is extracted before compatibility conversion. Unknown never means zero. */
export interface ProviderTokenUsage {
  inputTokens: string;
  outputTokens: string;
  totalTokens?: string;
  cachedInputTokens?: string;
  reasoningTokens?: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function quantity(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value)
    && BigInt(value) <= 9223372036854775807n) return value;
  return undefined;
}
/** Undefined means absent; null means invalid or contradictory evidence. Never
 * choose the first alias and silently discard a different authoritative value. */
function aliases(...values: unknown[]): string | null | undefined {
  let result: string | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    const parsed = quantity(value);
    if (parsed === undefined || (result !== undefined && result !== parsed)) return null;
    result = parsed;
  }
  return result;
}
export function providerTokenUsage(payload: unknown, maximumOutputTokens?: number): ProviderTokenUsage | null {
  if (!record(payload) || !record(payload.usage)) return null;
  // A reported nonstandard service cannot be priced using standard-only grants.
  if (payload.service_tier !== undefined && payload.service_tier !== "default") return null;
  const usage = payload.usage;
  for (const key of ["prompt_tokens_details", "input_tokens_details", "completion_tokens_details", "output_tokens_details"]) {
    if (usage[key] !== undefined && usage[key] !== null && !record(usage[key])) return null;
  }
  const detail = (key: string, field: string) => record(usage[key]) ? usage[key][field] : undefined;
  const inputTokens = aliases(usage.prompt_tokens, usage.input_tokens);
  const outputTokens = aliases(usage.completion_tokens, usage.output_tokens);
  if (inputTokens == null || outputTokens == null) return null;
  // Provider-side request limits are not sufficient evidence of conformance.
  // Compare the inclusive output count before splitting off reasoning for prices.
  if (maximumOutputTokens !== undefined && (!Number.isSafeInteger(maximumOutputTokens)
    || maximumOutputTokens <= 0 || BigInt(outputTokens) > BigInt(maximumOutputTokens))) return null;
  const result: ProviderTokenUsage = { inputTokens, outputTokens };
  const optional = [
    ["totalTokens", aliases(usage.total_tokens)],
    ["cachedInputTokens", aliases(detail("prompt_tokens_details", "cached_tokens"),
      detail("input_tokens_details", "cached_tokens"), usage.prompt_cache_hit_tokens)],
    ["reasoningTokens", aliases(detail("completion_tokens_details", "reasoning_tokens"),
      detail("output_tokens_details", "reasoning_tokens"), usage.reasoning_tokens)],
  ] as const;
  for (const [name, value] of optional) {
    if (value === null) return null;
    if (value !== undefined) result[name] = value;
  }
  if (result.totalTokens !== undefined && BigInt(result.totalTokens) !== BigInt(inputTokens) + BigInt(outputTokens)) return null;
  if (result.cachedInputTokens !== undefined && BigInt(result.cachedInputTokens) > BigInt(inputTokens)) return null;
  if (result.reasoningTokens !== undefined && BigInt(result.reasoningTokens) > BigInt(outputTokens)) return null;
  // DeepSeek reports cache hits and misses as a partition of prompt_tokens.
  // Validate that partition without inventing a missing hit measurement.
  if (usage.prompt_cache_miss_tokens !== undefined) {
    const misses = quantity(usage.prompt_cache_miss_tokens);
    if (misses === undefined || result.cachedInputTokens === undefined
      || BigInt(misses) + BigInt(result.cachedInputTokens) !== BigInt(inputTokens)) return null;
  }
  // These native cache fields do not share compatible-provider input semantics.
  // Until their own adapter/price dimensions exist, positive or invalid values
  // must remain uncertain rather than disappearing from a token-only receipt.
  for (const value of [usage.cache_creation_input_tokens, usage.cache_read_input_tokens,
    detail("input_tokens_details", "cache_write_tokens"), detail("prompt_tokens_details", "cache_write_tokens")]) {
    if (value !== undefined && quantity(value) !== "0") return null;
  }
  return result;
}
