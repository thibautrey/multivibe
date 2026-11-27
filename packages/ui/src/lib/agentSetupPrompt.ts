import { t } from "../i18n/core";

export interface AgentSetupPromptOptions {
  /** OpenAI-compatible API root, for example `https://api.multivibe.cloud/v1`. */
  apiBaseUrl: string;
  apiKey: string;
}

/**
 * Ready-to-paste instructions for a coding agent. The whole text is one
 * catalog key so translators can keep its structure and wording coherent.
 */
export function buildAgentSetupPrompt({ apiBaseUrl, apiKey }: AgentSetupPromptOptions): string {
  return t(
    `I just created an API key for MultiVibe, a multi-model AI platform with an OpenAI-compatible API.

API base URL: {apiBaseUrl}
API key: {apiKey}

Main endpoints:
- GET {apiBaseUrl}/models: list the available models.
- POST {apiBaseUrl}/chat/completions: OpenAI Chat Completions.
- POST {apiBaseUrl}/responses: OpenAI Responses API.
- POST {apiBaseUrl}/messages: Anthropic Messages API, useful for Claude Code.

Please configure the AI coding harnesses already installed on this machine (for example Codex, Claude Code, OpenCode, Cline, Roo Code, Continue or any other compatible tool) to use this endpoint and this key. Reuse each harness's existing configuration files and environment variables, and do not install a harness that is not already present or change unrelated settings.

Then test every harness you configured with one minimal request (a single short prompt such as "Reply with OK") using a model returned by GET {apiBaseUrl}/models. Report which harnesses are configured, which model each one used, and the exact result of each test. Never print the API key in your final answer.`,
    { apiBaseUrl, apiKey },
  );
}
