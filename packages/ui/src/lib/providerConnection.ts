export type OpenAIConnectionMode = "subscription" | "api-key";

export function providerAccountTarget(
  provider: string,
  sdkProvider: string,
  openAIConnectionMode: OpenAIConnectionMode,
) {
  if (provider === "openai" && openAIConnectionMode === "api-key") {
    return { provider: "ai-sdk", sdkProvider: "openai" } as const;
  }
  return {
    provider,
    sdkProvider: provider === "ai-sdk" ? sdkProvider : undefined,
  };
}
