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
export function providerTokenUsage(payload: unknown): ProviderTokenUsage | null {
  if (!record(payload) || !record(payload.usage)) return null;
  const usage = payload.usage;
  const inputTokens = quantity(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = quantity(usage.completion_tokens ?? usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return null;
  const result: ProviderTokenUsage = { inputTokens, outputTokens };
  const optional = [
    ["totalTokens", usage.total_tokens],
    ["cachedInputTokens", record(usage.prompt_tokens_details) ? usage.prompt_tokens_details.cached_tokens : undefined],
    ["reasoningTokens", record(usage.completion_tokens_details) ? usage.completion_tokens_details.reasoning_tokens : undefined],
  ] as const;
  for (const [name, value] of optional) {
    if (value === undefined) continue;
    const parsed = quantity(value);
    if (parsed === undefined) return null;
    result[name] = parsed;
  }
  if (result.totalTokens !== undefined && BigInt(result.totalTokens) !== BigInt(inputTokens) + BigInt(outputTokens)) return null;
  if (result.cachedInputTokens !== undefined && BigInt(result.cachedInputTokens) > BigInt(inputTokens)) return null;
  if (result.reasoningTokens !== undefined && BigInt(result.reasoningTokens) > BigInt(outputTokens)) return null;
  return result;
}
