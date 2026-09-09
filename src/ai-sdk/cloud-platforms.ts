import type { SdkProviderDefinition } from "./provider-definition.js";
import type { SdkCatalog } from "./catalog.js";

export const CLOUD_PLATFORM_PROVIDERS: readonly SdkProviderDefinition[] = [
  { id: "bedrock", name: "AWS Bedrock", adapter: "compatible", baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
    credentialLabel: "Amazon Bedrock API key", endpointPlaceholder: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1" },
  { id: "azure-foundry", name: "Azure AI Foundry", adapter: "compatible", baseURL: "", endpointRequired: true,
    endpointPlaceholder: "https://YOUR-RESOURCE.openai.azure.com/openai/v1", requiresModelSelection: true, credentialLabel: "Foundry resource API key" },
  { id: "vertex-express", name: "Google Vertex AI (Express)", adapter: "google", baseURL: "https://aiplatform.googleapis.com/v1/publishers/google",
    credentialLabel: "Vertex AI Express API key" },
  { id: "cloudflare", name: "Cloudflare Workers AI", adapter: "compatible", baseURL: "", endpointRequired: true,
    endpointPlaceholder: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1", credentialLabel: "Cloudflare API token" },
];

const reviewed = (source: string, id: string, models: string[]): SdkCatalog => ({ source, fetchedAt: "2026-09-09T00:00:00.000Z",
  models: { [id]: models.map((id) => ({ id, name: id, input: ["text"] })) } });
export const CLOUD_PLATFORM_CATALOGS: Record<string, SdkCatalog> = {
  bedrock: reviewed("https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html", "bedrock", ["openai.gpt-oss-120b"]),
  "azure-foundry": reviewed("https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/use-chat-completions", "azure-foundry", []),
  "vertex-express": reviewed("https://cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview", "vertex-express", ["gemini-2.5-flash", "gemini-2.5-pro"]),
  cloudflare: reviewed("https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/", "cloudflare", ["@cf/meta/llama-3.1-8b-instruct"]),
};

/** Account-specific endpoints must still belong to the reviewed cloud service. */
export function cloudPlatformEndpoint(providerId: string, raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error("Enter a valid provider endpoint URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || raw.includes("\\")) {
    throw new Error("Provider endpoints must use HTTPS without credentials, query parameters, ports or fragments");
  }
  const path = url.pathname.replace(/\/+$/, "");
  const allowed = providerId === "bedrock"
    ? /^bedrock-runtime\.[a-z]{2}(?:-[a-z]+)+-\d\.amazonaws\.com$/.test(url.hostname) && path === "/openai/v1" ||
      /^bedrock-mantle\.[a-z]{2}(?:-[a-z]+)+-\d\.api\.aws$/.test(url.hostname) && path === "/v1"
    : providerId === "azure-foundry"
      ? /^[a-z0-9][a-z0-9-]*\.(?:openai\.azure\.com|services\.ai\.azure\.com)$/.test(url.hostname) && path === "/openai/v1"
      : providerId === "cloudflare"
        ? url.hostname === "api.cloudflare.com" && /^\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\/v1$/.test(path)
        : false;
  if (!allowed) throw new Error(`Endpoint is not a supported ${providerId} inference endpoint`);
  return `${url.origin}${path}`;
}

export const CLOUD_PLATFORM_ACCESS = {
  bedrock: { paid: true, free: false, note: "Use an Amazon Bedrock API key and your region's OpenAI-compatible endpoint. AWS IAM access keys are not accepted in this field. Quotas are managed in AWS.", source: "https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html" },
  "azure-foundry": { paid: true, free: false, note: "Enter your Foundry resource endpoint and deployed model names. Uses the v1 cross-provider API; Azure billing and resource quotas stay in the Azure portal.", source: "https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/use-chat-completions" },
  "vertex-express": { paid: true, free: false, note: "Use a Vertex AI Express mode key. Trials are time limited; billing is pay-as-you-go. Standard project/service-account credentials are not Express keys.", source: "https://cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview" },
  cloudflare: { paid: true, free: true, note: "Use an API token with Workers AI permission and an endpoint containing your Cloudflare account ID. Daily compute allowances are managed in Cloudflare.", source: "https://developers.cloudflare.com/workers-ai/platform/pricing/" },
};
