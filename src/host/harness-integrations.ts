import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CONFIG_BYTES = 1024 * 1024;
const STATE_SCHEMA_VERSION = "multivibe-host-harness-integrations-v1";
const MANAGED_BLOCK_START = "# >>> MultiVibe Host >>>";
const MANAGED_BLOCK_END = "# <<< MultiVibe Host <<<";
const CODEX_ROOT_BLOCK_START = "# >>> MultiVibe Host Codex root >>>";
const CODEX_ROOT_BLOCK_END = "# <<< MultiVibe Host Codex root <<<";
const CODEX_PROVIDER_BLOCK_START = "# >>> MultiVibe Host Codex provider >>>";
const CODEX_PROVIDER_BLOCK_END = "# <<< MultiVibe Host Codex provider <<<";
const MODEL_CATALOG_CONFIGURATION_REVISION = 1;

export type HostHarnessCategory = "cli" | "editor" | "agent" | "framework" | "service";

export type HostHarnessView = {
  id: string;
  name: string;
  category: HostHarnessCategory;
  detected: boolean;
  detectedBy: string[];
  configured: boolean;
  managed: boolean;
  drifted: boolean;
  canInstall: boolean;
  repairable: boolean;
  canUninstall: boolean;
  configPath?: string;
  unavailableReason?: string;
  configurationIssue?: string;
  projectTracking?: "installed" | "not-installed" | "unavailable";
  effectiveProvider?: string;
  effectiveBaseUrl?: string;
};

export type HarnessContext = {
  baseUrl: string;
  apiKey: string;
  modelIds?: readonly string[];
};

type HarnessInspection = {
  configured: boolean;
  repairable: boolean;
  configurationIssue?: string;
  effectiveProvider?: string;
  effectiveBaseUrl?: string;
};

export type HarnessConfiguration = {
  relativePath: string;
  revision?: number;
  driftScope?: "file" | "managed";
  render: (current: string | null, context: HarnessContext) => string;
  prepare?: (context: HarnessContext) => Promise<Partial<HarnessContext>>;
  isConfigured: (current: string, baseUrl: string) => boolean;
  inspect?: (current: string, baseUrl: string, expectedApiKey?: string) => HarnessInspection;
};

export type HostHarnessDefinition = {
  id: string;
  name: string;
  category: HostHarnessCategory;
  executables: string[];
  footprints: string[];
  configuration?: HarnessConfiguration;
  unavailableReason?: string;
};

type InstallationState = {
  configPath: string;
  originalContentBase64: string | null;
  originalMode: number | null;
  installedSha256: string;
  apiKeyId: string;
  application: string;
  installedAt: number;
  configurationRevision?: number;
};

type HarnessState = {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  installations: Record<string, InstallationState>;
};

export class HostHarnessIntegrationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "HostHarnessIntegrationError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function parseJsonObject(current: string | null, relativePath: string): Record<string, unknown> {
  if (current === null || !current.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(current);
  } catch {
    throw new HostHarnessIntegrationError(`~/${relativePath} does not contain valid JSON`, 409);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HostHarnessIntegrationError(`~/${relativePath} must contain a JSON object`, 409);
  }
  return parsed as Record<string, unknown>;
}

function setJsonPath(root: Record<string, unknown>, segments: string[], value: unknown) {
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = value;
}

function jsonConfiguration(
  relativePath: string,
  patches: (context: HarnessContext) => Array<[string[], unknown]>,
): HarnessConfiguration {
  return {
    relativePath,
    render(current, context) {
      const document = parseJsonObject(current, relativePath);
      for (const [segments, value] of patches(context)) setJsonPath(document, segments, value);
      return `${JSON.stringify(document, null, 2)}\n`;
    },
    isConfigured(current, baseUrl) {
      return current.includes(baseUrl);
    },
  };
}

const DEFAULT_MODEL_ID = "gpt-5.5";

function safeModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function discoverMultiVibeModelIds(context: HarnessContext): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(`${context.baseUrl}/v1/models`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${context.apiKey}`,
      },
      redirect: "error",
    });
  } catch {
    throw new HostHarnessIntegrationError("MultiVibe model catalog is unavailable", 409);
  }
  if (!response.ok) {
    throw new HostHarnessIntegrationError(`MultiVibe model catalog unavailable (${response.status})`, 409);
  }
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_CONFIG_BYTES) {
    throw new HostHarnessIntegrationError("MultiVibe model catalog is too large to configure safely", 409);
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
    throw new HostHarnessIntegrationError("MultiVibe model catalog is too large to configure safely", 409);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new HostHarnessIntegrationError("MultiVibe model catalog is invalid", 409);
  }
  const modelIds = safeModelIds(
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { data?: unknown[] }).data?.map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as { id?: unknown }).id
          : undefined,
      )
      : undefined,
  );
  if (!modelIds.length) {
    throw new HostHarnessIntegrationError("MultiVibe model catalog is empty", 409);
  }
  return modelIds;
}

function requireModelIds(context: HarnessContext): string[] {
  const modelIds = safeModelIds(context.modelIds);
  if (!modelIds.length) {
    throw new HostHarnessIntegrationError("MultiVibe model catalog is empty", 409);
  }
  return modelIds;
}

function selectDefaultModelId(context: HarnessContext): string {
  const modelIds = requireModelIds(context);
  return modelIds.includes(DEFAULT_MODEL_ID) ? DEFAULT_MODEL_ID : modelIds[0];
}

async function prepareModelCatalog(context: HarnessContext): Promise<Partial<HarnessContext>> {
  return { modelIds: await discoverMultiVibeModelIds(context) };
}

function modelAwareConfiguration(configuration: HarnessConfiguration): HarnessConfiguration {
  return {
    ...configuration,
    revision: configuration.revision ?? MODEL_CATALOG_CONFIGURATION_REVISION,
    prepare: prepareModelCatalog,
  };
}

function openCodeModelMap(modelIds: readonly string[]): Record<string, { name: string }> {
  return Object.fromEntries(modelIds.map((id) => [id, { name: id }]));
}

function openCodeConfigurationDocument(
  current: string | null,
  context: HarnessContext,
): string {
  const document = parseJsonObject(current, ".config/opencode/opencode.json");
  const modelIds = requireModelIds(context);
  const currentModel = typeof document.model === "string" && document.model.startsWith("multivibe/")
    ? document.model.slice("multivibe/".length)
    : "";
  const selectedModel = modelIds.includes(currentModel)
    ? currentModel
    : modelIds.includes(DEFAULT_MODEL_ID)
      ? DEFAULT_MODEL_ID
      : modelIds[0];
  setJsonPath(document, ["model"], `multivibe/${selectedModel}`);
  setJsonPath(document, ["provider", "multivibe"], {
    npm: "@ai-sdk/openai-compatible",
    name: "MultiVibe Host",
    options: { baseURL: `${context.baseUrl}/v1`, apiKey: context.apiKey },
    models: openCodeModelMap(modelIds),
  });
  return `${JSON.stringify(document, null, 2)}\n`;
}

const openCodeConfiguration: HarnessConfiguration = {
  relativePath: ".config/opencode/opencode.json",
  revision: 2,
  prepare: prepareModelCatalog,
  render: openCodeConfigurationDocument,
  isConfigured: (current, baseUrl) => current.includes(baseUrl),
};

function managedBlockConfiguration(
  relativePath: string,
  block: (context: HarnessContext) => string,
): HarnessConfiguration {
  return {
    relativePath,
    render(current, context) {
      const withoutManaged = stripManagedBlock(current ?? "").trimEnd();
      const prefix = withoutManaged ? `${withoutManaged}\n\n` : "";
      return `${prefix}${MANAGED_BLOCK_START}\n${block(context).trim()}\n${MANAGED_BLOCK_END}\n`;
    },
    isConfigured(current, baseUrl) {
      return current.includes(baseUrl);
    },
  };
}

function stripManagedBlock(value: string): string {
  const start = value.indexOf(MANAGED_BLOCK_START);
  if (start < 0) return value;
  const end = value.indexOf(MANAGED_BLOCK_END, start);
  if (end < 0) {
    throw new HostHarnessIntegrationError("the existing MultiVibe configuration block is incomplete", 409);
  }
  return `${value.slice(0, start)}${value.slice(end + MANAGED_BLOCK_END.length)}`;
}

type CodexTomlInspection = HarnessInspection & {
  profileProviders: Record<string, string>;
  rootModelCatalogJson?: string;
};

function decodeTomlBasicString(value: string): string | undefined {
  const match = /^"((?:\\.|[^"\\])*)"/.exec(value.trim());
  if (!match) return undefined;
  return match[1].replace(/\\(["\\])/g, "$1");
}

function matchTomlTableHeader(line: string): string | undefined {
  // Quoted keys and bare characters must be disjoint to avoid backtracking.
  const match = /^\s*\[((?:"(?:\\.|[^"\\])*"|'[^']*'|[^\[\]"'])+)\]\s*(?:#.*)?$/.exec(line);
  return match?.[1].trim();
}

function parseCodexToml(current: string, expectedBaseUrl: string, expectedApiKey?: string): CodexTomlInspection {
  let table = "";
  let rootProvider: string | undefined;
  let providerBaseUrl: string | undefined;
  let providerBearerToken: string | undefined;
  let providerWireApi: string | undefined;
  let rootModelCatalogJson: string | undefined;
  const profileProviders: Record<string, string> = {};
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const [index, line] of current.split(/\r?\n/).entries()) {
    const tableMatch = matchTomlTableHeader(line);
    if (tableMatch) {
      table = tableMatch;
      continue;
    }
    if (/^\s*\[/.test(line) && !/^\s*\[\[/.test(line)) {
      errors.push(`invalid TOML table header on line ${index + 1}`);
      continue;
    }

    const assignment = /^\s*([A-Za-z0-9_-]+)\s*=\s*("(?:\\.|[^"\\])*")\s*(?:#.*)?$/.exec(line);
    if (!assignment) continue;
    const key = assignment[1];
    const value = decodeTomlBasicString(assignment[2]);
    if (value === undefined) continue;
    if (table === "" && key === "model_provider") {
      if (seen.has("root.model_provider")) errors.push("duplicate root model_provider");
      seen.add("root.model_provider");
      rootProvider = value;
    } else if (table === "" && key === "model_catalog_json") {
      if (seen.has("root.model_catalog_json")) errors.push("duplicate root model_catalog_json");
      seen.add("root.model_catalog_json");
      rootModelCatalogJson = value;
    } else if (table.startsWith("profiles.") && key === "model_provider") {
      const profile = table.slice("profiles.".length);
      const seenKey = `profile.${profile}.model_provider`;
      if (seen.has(seenKey)) errors.push(`duplicate ${seenKey}`);
      seen.add(seenKey);
      profileProviders[profile] = value;
    } else if (table === "model_providers.multivibe" && key === "base_url") {
      if (seen.has("provider.multivibe.base_url")) errors.push("duplicate model_providers.multivibe.base_url");
      seen.add("provider.multivibe.base_url");
      providerBaseUrl = value;
    } else if (table === "model_providers.multivibe" && key === "experimental_bearer_token") {
      if (seen.has("provider.multivibe.experimental_bearer_token")) errors.push("duplicate model_providers.multivibe.experimental_bearer_token");
      seen.add("provider.multivibe.experimental_bearer_token");
      providerBearerToken = value;
    } else if (table === "model_providers.multivibe" && key === "wire_api") {
      if (seen.has("provider.multivibe.wire_api")) errors.push("duplicate model_providers.multivibe.wire_api");
      seen.add("provider.multivibe.wire_api");
      providerWireApi = value;
    }
  }

  const profileOverrides = Object.entries(profileProviders)
    .filter(([, provider]) => provider !== "multivibe")
    .map(([profile, provider]) => `${profile}=${provider}`);
  const configurationIssues = [
    ...(rootModelCatalogJson !== undefined
      ? ["Codex model_catalog_json overrides MultiVibe model discovery"]
      : []),
    ...(profileOverrides.length > 0
      ? [`Codex profiles override MultiVibe: ${profileOverrides.join(", ")}`]
      : []),
  ];
  const configurationIssue = configurationIssues.length > 0
    ? configurationIssues.join("; ")
    : undefined;
  return {
    configured: rootProvider === "multivibe" &&
      providerBaseUrl === expectedBaseUrl &&
      (expectedApiKey ? providerBearerToken === expectedApiKey : Boolean(providerBearerToken)) &&
      providerWireApi === "responses" &&
      rootModelCatalogJson === undefined,
    repairable: errors.length === 0,
    configurationIssue: errors.length > 0 ? errors.join("; ") : configurationIssue,
    effectiveProvider: rootProvider,
    effectiveBaseUrl: providerBaseUrl,
    profileProviders,
    rootModelCatalogJson,
  };
}

function inspectCodexToml(current: string, baseUrl: string, expectedApiKey?: string): HarnessInspection {
  const parsed = parseCodexToml(current, `${baseUrl}/v1`, expectedApiKey);
  return {
    ...parsed,
    configured: parsed.configured,
  };
}

function isCodexMarker(line: string, marker: string): boolean {
  return line.trim() === marker;
}

function stripCodexManagedContent(value: string): string {
  const output: string[] = [];
  let table = "";
  let insideManagedBlock = false;
  let skippingProvider = false;
  let blockEnd: string | undefined;
  for (const line of value.split(/\r?\n/)) {
    if (!insideManagedBlock && (
      isCodexMarker(line, MANAGED_BLOCK_START) ||
      isCodexMarker(line, CODEX_ROOT_BLOCK_START) ||
      isCodexMarker(line, CODEX_PROVIDER_BLOCK_START)
    )) {
      insideManagedBlock = true;
      blockEnd = isCodexMarker(line, MANAGED_BLOCK_START)
        ? MANAGED_BLOCK_END
        : isCodexMarker(line, CODEX_ROOT_BLOCK_START) ? CODEX_ROOT_BLOCK_END : CODEX_PROVIDER_BLOCK_END;
      continue;
    }
    if (insideManagedBlock && blockEnd && isCodexMarker(line, blockEnd)) {
      insideManagedBlock = false;
      blockEnd = undefined;
      skippingProvider = false;
      continue;
    }
    const tableMatch = matchTomlTableHeader(line);
    if (tableMatch) {
      table = tableMatch;
      skippingProvider = table === "model_providers.multivibe";
      if (skippingProvider) continue;
    }
    if (skippingProvider) continue;
    if (table === "" && /^\s*(?:model_provider|model_catalog_json)\s*=/.test(line)) continue;
    if (insideManagedBlock && /^\s*(?:model_provider|model_catalog_json)\s*=/.test(line)) continue;
    output.push(line);
  }
  if (insideManagedBlock) {
    throw new HostHarnessIntegrationError("the existing MultiVibe configuration block is incomplete", 409);
  }
  return output.join("\n");
}

function renderCodexToml(current: string | null, context: HarnessContext): string {
  const value = stripCodexManagedContent(current ?? "").trim();
  const rootBlock = `${CODEX_ROOT_BLOCK_START}\nmodel_provider = "multivibe"\n${CODEX_ROOT_BLOCK_END}`;
  const providerBlock = `${CODEX_PROVIDER_BLOCK_START}\n[model_providers.multivibe]\nname = "MultiVibe Host"\nbase_url = ${jsonString(`${context.baseUrl}/v1`)}\nexperimental_bearer_token = ${jsonString(context.apiKey)}\nwire_api = "responses"\n${CODEX_PROVIDER_BLOCK_END}`;
  return `${rootBlock}\n\n${value ? `${value}\n\n` : ""}${providerBlock}\n`;
}

const codexConfiguration: HarnessConfiguration = {
  relativePath: ".codex/config.toml",
  driftScope: "managed",
  render: renderCodexToml,
  isConfigured: (current, baseUrl) => inspectCodexToml(current, baseUrl).configured,
  inspect: inspectCodexToml,
};

const claudeConfiguration = jsonConfiguration(".claude/settings.json", ({ baseUrl, apiKey }) => [
  [["env", "ANTHROPIC_BASE_URL"], baseUrl],
  [["env", "ANTHROPIC_AUTH_TOKEN"], apiKey],
]);

const openClawConfiguration = modelAwareConfiguration(jsonConfiguration(".openclaw/openclaw.json", ({ baseUrl, apiKey, modelIds }) => [
  [["agents", "defaults", "model", "primary"], `multivibe/${selectDefaultModelId({ baseUrl, apiKey, modelIds })}`],
  [["models", "providers", "multivibe"], {
    baseUrl: `${baseUrl}/v1`,
    apiKey,
    api: "openai-responses",
    models: requireModelIds({ baseUrl, apiKey, modelIds }).map((id) => ({ id, name: id })),
  }],
]));

const piConfiguration = modelAwareConfiguration(jsonConfiguration(".pi/agent/models.json", ({ baseUrl, apiKey, modelIds }) => [
  [["providers", "multivibe"], {
    baseUrl: `${baseUrl}/v1`,
    apiKey,
    api: "openai-responses",
    models: requireModelIds({ baseUrl, apiKey, modelIds }).map((id) => ({ id, name: id })),
  }],
]));

const qwenConfiguration = jsonConfiguration(".qwen/settings.json", ({ baseUrl, apiKey }) => [
  [["env", "OPENAI_BASE_URL"], `${baseUrl}/v1`],
  [["env", "OPENAI_API_KEY"], apiKey],
]);

const crushConfiguration = modelAwareConfiguration(jsonConfiguration(".config/crush/crush.json", ({ baseUrl, apiKey, modelIds }) => [
  [["providers", "multivibe"], {
    type: "openai",
    base_url: `${baseUrl}/v1`,
    api_key: apiKey,
    models: requireModelIds({ baseUrl, apiKey, modelIds }).map((id) => ({ id, name: id })),
  }],
]));

const hermesConfiguration = modelAwareConfiguration(managedBlockConfiguration(".hermes/.env", ({ baseUrl, apiKey, modelIds }) => [
  "LLM_PROVIDER=openai",
  `LLM_MODEL=${selectDefaultModelId({ baseUrl, apiKey, modelIds })}`,
  `OPENAI_BASE_URL=${baseUrl}/v1`,
  `OPENAI_API_KEY=${apiKey}`,
].join("\n")));

const gooseConfiguration = modelAwareConfiguration(managedBlockConfiguration(".config/goose/config.yaml", ({ baseUrl, apiKey, modelIds }) => [
  "GOOSE_PROVIDER: openai",
  `GOOSE_MODEL: ${jsonString(selectDefaultModelId({ baseUrl, apiKey, modelIds }))}`,
  `OPENAI_HOST: ${jsonString(`${baseUrl}/v1`)}`,
  `OPENAI_API_KEY: ${jsonString(apiKey)}`,
].join("\n")));

const openHandsConfiguration = modelAwareConfiguration(managedBlockConfiguration(".openhands/config.toml", ({ baseUrl, apiKey, modelIds }) => [
  "[llm]",
  `model = ${jsonString(`openai/${selectDefaultModelId({ baseUrl, apiKey, modelIds })}`)}`,
  `base_url = ${jsonString(`${baseUrl}/v1`)}`,
  `api_key = ${jsonString(apiKey)}`,
].join("\n")));

const aiderConfiguration = modelAwareConfiguration(managedBlockConfiguration(".aider.conf.yml", ({ baseUrl, apiKey, modelIds }) => [
  `model: ${jsonString(`openai/${selectDefaultModelId({ baseUrl, apiKey, modelIds })}`)}`,
  `openai-api-base: ${jsonString(`${baseUrl}/v1`)}`,
  `openai-api-key: ${jsonString(apiKey)}`,
].join("\n")));

const continueConfiguration = modelAwareConfiguration(managedBlockConfiguration(".continue/config.yaml", ({ baseUrl, apiKey, modelIds }) => [
  "models:",
  ...requireModelIds({ baseUrl, apiKey, modelIds }).map((id) => [
    `  - name: ${jsonString(`MultiVibe Host / ${id}`)}`,
    "    provider: openai",
    `    model: ${jsonString(id)}`,
    `    apiBase: ${jsonString(`${baseUrl}/v1`)}`,
    `    apiKey: ${jsonString(apiKey)}`,
  ].join("\n")),
].join("\n")));

function miniSweAgentGlobalConfigPath(): string {
  if (process.platform === "darwin") return "Library/Application Support/mini-swe-agent/.env";
  if (process.platform === "win32") return "AppData/Local/mini-swe-agent/mini-swe-agent/.env";
  return ".config/mini-swe-agent/.env";
}

const miniSweAgentConfiguration = modelAwareConfiguration(managedBlockConfiguration(
  miniSweAgentGlobalConfigPath(),
  ({ baseUrl, apiKey, modelIds }) => [
    'MSWEA_CONFIGURED="true"',
    `MSWEA_MODEL_NAME=${jsonString(`openai/${selectDefaultModelId({ baseUrl, apiKey, modelIds })}`)}`,
    `OPENAI_API_KEY=${jsonString(apiKey)}`,
    `OPENAI_API_BASE=${jsonString(`${baseUrl}/v1`)}`,
    `OPENAI_BASE_URL=${jsonString(`${baseUrl}/v1`)}`,
    'MSWEA_COST_TRACKING="ignore_errors"',
  ].join("\n"),
));

function renderGptmeToml(current: string | null, context: HarnessContext): string {
  const modelId = selectDefaultModelId(context);
  const lines = stripManagedBlock(current ?? "").trimEnd().split(/\r?\n/);
  const output: string[] = [];
  let table = "";
  let envTableSeen = false;
  let modelWritten = false;
  const writeModel = () => {
    if (!modelWritten) output.push(`MODEL = ${jsonString(`multivibe/${modelId}`)}`);
    modelWritten = true;
  };

  for (const line of lines) {
    const nextTable = /^\s*\[\[/.test(line) ? "__array__" : matchTomlTableHeader(line);
    if (nextTable !== undefined) {
      if (table === "env") writeModel();
      table = nextTable;
      if (table === "env") {
        if (envTableSeen) throw new HostHarnessIntegrationError("~/.config/gptme/config.toml contains duplicate [env] tables", 409);
        envTableSeen = true;
      }
      output.push(line);
      continue;
    }
    if (table === "env" && /^\s*MODEL\s*=/.test(line)) {
      if (modelWritten) throw new HostHarnessIntegrationError("~/.config/gptme/config.toml contains duplicate env.MODEL values", 409);
      writeModel();
      continue;
    }
    output.push(line);
  }
  if (table === "env") writeModel();
  if (!envTableSeen) {
    if (output.some((line) => line.trim())) output.push("");
    output.push("[env]");
    writeModel();
  }
  const prefix = output.join("\n").trimEnd();
  const provider = [
    "[[providers]]",
    'name = "multivibe"',
    `base_url = ${jsonString(`${context.baseUrl}/v1`)}`,
    `api_key = ${jsonString(context.apiKey)}`,
    `default_model = ${jsonString(modelId)}`,
  ].join("\n");
  return `${prefix ? `${prefix}\n\n` : ""}${MANAGED_BLOCK_START}\n${provider}\n${MANAGED_BLOCK_END}\n`;
}

const gptmeConfiguration = modelAwareConfiguration({
  relativePath: ".config/gptme/config.toml",
  render: renderGptmeToml,
  isConfigured: (current, baseUrl) => current.includes(`${baseUrl}/v1`),
});

const shellGptConfiguration = modelAwareConfiguration(managedBlockConfiguration(
  ".config/shell_gpt/.sgptrc",
  ({ baseUrl, apiKey, modelIds }) => [
    `OPENAI_API_KEY=${jsonString(apiKey)}`,
    `API_BASE_URL=${jsonString(`${baseUrl}/v1`)}`,
    `DEFAULT_MODEL=${jsonString(selectDefaultModelId({ baseUrl, apiKey, modelIds }))}`,
  ].join("\n"),
));

const interpreterConfiguration = modelAwareConfiguration(managedBlockConfiguration(".config/open-interpreter/config.yaml", ({ baseUrl, apiKey, modelIds }) => [
  "llm:",
  `  model: ${jsonString(`openai/${selectDefaultModelId({ baseUrl, apiKey, modelIds })}`)}`,
  `  api_base: ${jsonString(`${baseUrl}/v1`)}`,
  `  api_key: ${jsonString(apiKey)}`,
].join("\n")));

const agentZeroConfiguration = modelAwareConfiguration(managedBlockConfiguration(".agent-zero/.env", ({ baseUrl, apiKey, modelIds }) => [
  "API_PROVIDER=openai",
  `CHAT_MODEL=${selectDefaultModelId({ baseUrl, apiKey, modelIds })}`,
  `OPENAI_BASE_URL=${baseUrl}/v1`,
  `OPENAI_API_KEY=${apiKey}`,
].join("\n")));

const autoGptConfiguration = modelAwareConfiguration(managedBlockConfiguration(".autogpt/.env", ({ baseUrl, apiKey, modelIds }) => [
  `OPENAI_API_BASE_URL=${baseUrl}/v1`,
  `OPENAI_API_KEY=${apiKey}`,
  `SMART_LLM=${selectDefaultModelId({ baseUrl, apiKey, modelIds })}`,
  `FAST_LLM=${selectDefaultModelId({ baseUrl, apiKey, modelIds })}`,
].join("\n")));

const manualReason = "This harness does not expose a stable, safe per-user OpenAI-compatible configuration file that MultiVibe Host can edit automatically.";
const projectReason = "This framework is configured per project. MultiVibe Host detected it but will not rewrite arbitrary project files.";

function definition(
  id: string,
  name: string,
  category: HostHarnessCategory,
  executables: string[],
  footprints: string[],
  configuration?: HarnessConfiguration,
  unavailableReason?: string,
): HostHarnessDefinition {
  return { id, name, category, executables, footprints, configuration, unavailableReason };
}

export const HOST_HARNESS_DEFINITIONS: readonly HostHarnessDefinition[] = [
  definition("claude-code", "Claude Code", "cli", ["claude"], [".claude"], claudeConfiguration),
  definition("openai-codex", "OpenAI Codex", "cli", ["codex"], [".codex"], codexConfiguration),
  definition("opencode", "OpenCode", "cli", ["opencode"], [".config/opencode"], openCodeConfiguration),
  definition("openclaw", "OpenClaw", "agent", ["openclaw"], [".openclaw"], openClawConfiguration),
  definition("hermes-agent", "Hermes Agent", "agent", ["hermes"], [".hermes"], hermesConfiguration),
  definition("pi", "Pi", "cli", ["pi"], [".pi/agent"], piConfiguration),
  definition("goose", "Goose", "agent", ["goose"], [".config/goose"], gooseConfiguration),
  definition("openhands", "OpenHands", "agent", ["openhands"], [".openhands"], openHandsConfiguration),
  definition("cline", "Cline", "editor", ["cline"], [".vscode/extensions/saoudrizwan.claude-dev-*", "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev", ".config/Code/User/globalStorage/saoudrizwan.claude-dev"], undefined, manualReason),
  definition("aider", "Aider", "cli", ["aider"], [".aider.conf.yml"], aiderConfiguration),
  definition("qwen-code", "Qwen Code", "cli", ["qwen"], [".qwen"], qwenConfiguration),
  definition("gemini-cli", "Gemini CLI", "cli", ["gemini"], [".gemini"], undefined, manualReason),
  definition("antigravity", "Google Antigravity", "editor", ["antigravity"], ["Library/Application Support/Antigravity", ".config/Antigravity"], undefined, manualReason),
  definition("github-copilot-cli", "GitHub Copilot CLI / Coding Agent", "cli", ["copilot", "github-copilot"], [".config/github-copilot"], undefined, manualReason),
  definition("kiro-cli", "Kiro / Kiro CLI", "cli", ["kiro", "kiro-cli"], [".kiro", "Library/Application Support/Kiro"], undefined, manualReason),
  definition("warp-agent", "Warp Agent", "editor", ["warp"], ["Library/Application Support/dev.warp.Warp-Stable", ".config/warp-terminal"], undefined, manualReason),
  definition("amp", "Amp", "cli", ["amp"], [".config/amp"], undefined, manualReason),
  definition("crush", "Crush", "cli", ["crush"], [".config/crush"], crushConfiguration),
  definition("kilo-code", "Kilo Code", "editor", ["kilo"], [".vscode/extensions/kilocode.kilo-code-*", "Library/Application Support/Code/User/globalStorage/kilocode.kilo-code", ".config/Code/User/globalStorage/kilocode.kilo-code"], undefined, manualReason),
  definition("roo-code", "Roo Code", "editor", ["roo"], [".vscode/extensions/rooveterinaryinc.roo-cline-*", "Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline", ".config/Code/User/globalStorage/rooveterinaryinc.roo-cline"], undefined, manualReason),
  definition("continue", "Continue", "editor", ["cn", "continue"], [".continue", ".vscode/extensions/continue.continue-*"], continueConfiguration),
  definition("mini-swe-agent", "mini-SWE-agent", "agent", ["mini", "mini-extra"], [
    ".config/mini-swe-agent",
    "Library/Application Support/mini-swe-agent",
    "AppData/Local/mini-swe-agent/mini-swe-agent",
  ], miniSweAgentConfiguration),
  definition("mistral-vibe", "Mistral Vibe", "agent", ["vibe"], [".vibe"], undefined, manualReason),
  definition("gptme", "gptme", "agent", ["gptme"], [".config/gptme"], gptmeConfiguration),
  definition("aichat", "AIChat", "agent", ["aichat"], [".config/aichat"], undefined, manualReason),
  definition("shell-gpt", "ShellGPT", "cli", ["sgpt"], [".config/shell_gpt"], shellGptConfiguration),
  definition("fabric", "Fabric", "framework", ["fabric"], [".config/fabric"], undefined, manualReason),
  definition("gptscript", "GPTScript", "framework", ["gptscript"], [".config/gptscript"], undefined, projectReason),
  definition("kimi-code", "Kimi Code CLI", "agent", ["kimi"], [".kimi-code", ".kimi"], undefined, manualReason),
  definition("pochi", "Pochi", "editor", [], [
    ".vscode/extensions/tabbyml.pochi-*",
    "Library/Application Support/Code/User/globalStorage/tabbyml.pochi",
    ".config/Code/User/globalStorage/tabbyml.pochi",
  ], undefined, manualReason),
  definition("zed-agent", "Zed Agent Panel", "editor", ["zed"], [".config/zed", "Library/Application Support/Zed"], undefined, manualReason),
  definition("jetbrains-junie", "JetBrains Junie", "editor", ["junie"], [".junie", ".junie.json"], undefined, manualReason),
  definition("amazon-q-developer", "Amazon Q Developer CLI", "agent", ["q", "qchat"], [".aws/amazonq", ".local/share/amazon-q"], undefined, manualReason),
  definition("sourcegraph-cody", "Sourcegraph Cody", "editor", ["cody"], [
    ".vscode/extensions/sourcegraph.cody-ai-*",
    "Library/Application Support/Code/User/globalStorage/sourcegraph.cody-ai",
    ".config/Code/User/globalStorage/sourcegraph.cody-ai",
  ], undefined, manualReason),
  definition("tabby", "Tabby", "editor", ["tabby"], [
    ".tabby", ".vscode/extensions/tabbyml.vscode-tabby-*",
    "Library/Application Support/Code/User/globalStorage/tabbyml.vscode-tabby",
    ".config/Code/User/globalStorage/tabbyml.vscode-tabby",
  ], undefined, manualReason),
  definition("trae", "Trae", "editor", ["trae"], [".trae", "Library/Application Support/Trae"], undefined, manualReason),
  definition("qoder", "Qoder", "editor", ["qoder", "qodercli"], [".qoder", "Library/Application Support/Qoder"], undefined, manualReason),
  definition("coderabbit-cli", "CodeRabbit CLI", "agent", ["coderabbit"], [".coderabbit", ".coderabbit.yaml", ".coderabbit.yml"], undefined, projectReason),
  definition("qodo-merge", "Qodo Merge / PR-Agent", "agent", ["qodo", "pr-agent"], [".qodo", ".pr_agent.toml"], undefined, projectReason),
  definition("gpt-engineer", "GPT Engineer", "agent", ["gpte", "gpt-engineer"], [".gpteng"], undefined, projectReason),
  definition("aider-desk", "AiderDesk", "editor", ["aider-desk"], [".aider-desk", "Library/Application Support/AiderDesk"], undefined, manualReason),
  definition("pearai", "PearAI", "editor", ["pearai"], [".pearai", "Library/Application Support/PearAI"], undefined, manualReason),
  definition("devika", "Devika", "agent", ["devika"], [".devika"], undefined, projectReason),
  definition("smol-developer", "smol developer", "agent", ["smol-dev"], [".smol-dev"], undefined, projectReason),
  definition("swe-smith", "SWE-smith", "framework", ["swe-smith"], [".swe-smith"], undefined, projectReason),
  definition("swe-rex", "SWE-ReX", "framework", ["swerex", "swe-rex"], [".swerex"], undefined, projectReason),
  definition("agentless", "Agentless", "agent", ["agentless"], [".agentless"], undefined, projectReason),
  definition("open-interpreter", "Open Interpreter", "cli", ["interpreter"], [".config/open-interpreter"], interpreterConfiguration),
  definition("swe-agent", "SWE-agent", "agent", ["sweagent", "swe-agent"], [".config/swe-agent"], undefined, projectReason),
  definition("autocoderover", "AutoCodeRover", "agent", ["autocoderover", "acr"], [".autocoderover"], undefined, projectReason),
  definition("mentat", "Mentat", "cli", ["mentat"], [".mentat"], undefined, projectReason),
  definition("gpt-pilot", "GPT-Pilot", "agent", ["gpt-pilot"], [".gpt-pilot"], undefined, projectReason),
  definition("plandex", "Plandex", "cli", ["plandex"], [".plandex"], undefined, manualReason),
  definition("cursor-agent", "Cursor Agent", "editor", ["cursor-agent", "cursor"], [".cursor", "Library/Application Support/Cursor"], undefined, manualReason),
  definition("windsurf-cascade", "Windsurf Cascade", "editor", ["windsurf"], [".codeium/windsurf", "Library/Application Support/Windsurf"], undefined, manualReason),
  definition("devin", "Devin", "service", ["devin"], [".config/devin"], undefined, manualReason),
  definition("pythagora", "Pythagora", "agent", ["pythagora"], [".pythagora"], undefined, projectReason),
  definition("agent-zero", "Agent Zero", "agent", ["agent-zero"], [".agent-zero"], agentZeroConfiguration),
  definition("openmanus", "OpenManus", "agent", ["openmanus"], [".openmanus"], undefined, projectReason),
  definition("manus", "Manus", "service", ["manus"], [".config/manus"], undefined, manualReason),
  definition("autogen", "AutoGen", "framework", ["autogenstudio", "autogen"], [".autogenstudio"], undefined, projectReason),
  definition("crewai", "CrewAI", "framework", ["crewai"], [".config/crewai"], undefined, projectReason),
  definition("langgraph", "LangGraph", "framework", ["langgraph"], [".config/langgraph"], undefined, projectReason),
  definition("smolagents", "smolagents", "framework", ["smolagents"], [".cache/huggingface/modules/transformers_modules"], undefined, projectReason),
  definition("letta", "Letta", "framework", ["letta"], [".letta"], undefined, projectReason),
  definition("autogpt", "AutoGPT", "agent", ["autogpt"], [".autogpt"], autoGptConfiguration),
  definition("babyagi", "BabyAGI", "agent", ["babyagi"], [".babyagi"], undefined, projectReason),
  definition("metagpt", "MetaGPT", "framework", ["metagpt"], [".metagpt"], undefined, projectReason),
  definition("superagi", "SuperAGI", "agent", ["superagi"], [".superagi"], undefined, projectReason),
  definition("agentgpt", "AgentGPT", "agent", ["agentgpt"], [".agentgpt"], undefined, projectReason),
  definition("camel", "CAMEL", "framework", ["camel-ai"], [".camel"], undefined, projectReason),
  definition("pydanticai", "PydanticAI", "framework", ["pydantic-ai"], [".config/pydantic-ai"], undefined, projectReason),
  definition("mastra", "Mastra", "framework", ["mastra"], [".mastra"], undefined, projectReason),
  definition("agno", "Agno", "framework", ["agno"], [".config/agno"], undefined, projectReason),
  definition("semantic-kernel", "Semantic Kernel", "framework", ["semantic-kernel"], [".config/semantic-kernel"], undefined, projectReason),
  definition("llamaindex-agents", "LlamaIndex Agents", "framework", ["llamaindex-cli"], [".config/llamaindex"], undefined, projectReason),
  definition("langchain-agents", "LangChain Agents", "framework", ["langchain"], [".config/langchain"], undefined, projectReason),
  definition("deepseek-harness", "deepseek-harness", "agent", ["deepseek-harness"], [".deepseek-harness"], undefined, projectReason),
];

const DEFAULT_EXECUTABLE_DIRECTORIES = [
  ".local/bin",
  ".npm-global/bin",
  ".bun/bin",
  ".cargo/bin",
  ".deno/bin",
  "Library/pnpm",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
];

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readBounded(filePath: string): Promise<{ content: string; mode: number } | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) throw new HostHarnessIntegrationError(`${filePath} is a symbolic link`, 409);
    if (!stat.isFile()) throw new HostHarnessIntegrationError(`${filePath} is not a regular file`, 409);
    if (stat.size > MAX_CONFIG_BYTES) throw new HostHarnessIntegrationError(`${filePath} is too large to edit safely`, 409);
    return { content: await fs.readFile(filePath, "utf8"), mode: stat.mode & 0o777 };
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(filePath: string, content: string, mode = 0o600) {
  if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) {
    throw new HostHarnessIntegrationError(`${filePath} would exceed the safe configuration size`, 409);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.multivibe-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, mode);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function footprintExists(homeDirectory: string, footprint: string): Promise<boolean> {
  const absolute = footprint.startsWith("/") ? footprint : path.join(homeDirectory, footprint);
  const basename = path.basename(absolute);
  if (!basename.includes("*")) {
    return fs.lstat(absolute).then(() => true, () => false);
  }
  const expression = new RegExp(`^${basename.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return fs.readdir(path.dirname(absolute)).then(
    (entries) => entries.some((entry) => expression.test(entry)),
    () => false,
  );
}

export type HostHarnessManagerOptions = {
  homeDirectory: string;
  statePath: string;
  baseUrl: string;
  projectRegistrationToken?: string;
  apiKeyForId?: (id: string) => string | undefined;
  definitions?: readonly HostHarnessDefinition[];
  executableDirectories?: string[];
};

export class HostHarnessIntegrationManager {
  private readonly homeDirectory: string;
  private readonly statePath: string;
  private readonly baseUrl: string;
  private readonly apiKeyForId: (id: string) => string | undefined;
  private readonly definitions: readonly HostHarnessDefinition[];
  private readonly executableDirectories: string[];
  private readonly projectRegistrationToken: string;
  private operation = Promise.resolve();

  constructor(options: HostHarnessManagerOptions) {
    if (!path.isAbsolute(options.homeDirectory)) {
      throw new Error("Host harness home directory must be absolute");
    }
    this.projectRegistrationToken = options.projectRegistrationToken ?? "";
    this.homeDirectory = path.resolve(options.homeDirectory);
    this.statePath = path.resolve(options.statePath);
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKeyForId = options.apiKeyForId ?? (() => undefined);
    this.definitions = options.definitions ?? HOST_HARNESS_DEFINITIONS;
    this.executableDirectories = options.executableDirectories ?? DEFAULT_EXECUTABLE_DIRECTORIES;
    const parsed = new URL(this.baseUrl);
    if (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]", "::1"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname !== "/") {
      throw new Error("Host harness integrations require a credential-free loopback HTTP base URL");
    }
  }

  async list(): Promise<HostHarnessView[]> {
    const state = await this.readState();
    return Promise.all(this.definitions.map((entry) => this.view(entry, state)));
  }

  async get(id: string): Promise<HostHarnessView> {
    const definition = this.definition(id);
    return this.view(definition, await this.readState());
  }

  async enableProjectTracking(id: string): Promise<HostHarnessView> {
    return this.serial(async () => {
      const current = await this.view(this.definition(id), await this.readState());
      if (id !== "openai-codex" || !current.detected) {
        throw new HostHarnessIntegrationError("Project tracking requires Codex on this host", 409);
      }
      if (!this.projectRegistrationToken) {
        throw new HostHarnessIntegrationError("Codex project registration is disabled", 503);
      }
      await this.writeProjectTracking();
      return this.view(this.definition(id), await this.readState());
    });
  }

  private async projectTrackingFiles() {
    const paths = await Promise.all([
      ".codex/hooks.json", ".codex/multivibe-project.json", ".codex/hooks/multivibe-project-hook.mjs",
    ].map((relative) => this.safeConfigPath(relative)));
    const originals = await Promise.all(paths.map((file) => readBounded(file)));
    const manifest = parseJsonObject(originals[0]?.content ?? null, ".codex/hooks.json");
    if (manifest.hooks !== undefined && (!manifest.hooks || typeof manifest.hooks !== "object" || Array.isArray(manifest.hooks))) {
      throw new HostHarnessIntegrationError("Codex hooks must contain a hooks object", 409);
    }
    const hooks = (manifest.hooks ?? {}) as Record<string, any>;
    if (hooks.SessionStart !== undefined && !Array.isArray(hooks.SessionStart)) {
      throw new HostHarnessIntegrationError("Codex SessionStart hooks must be an array", 409);
    }
    return { paths, originals, manifest, hooks };
  }

  private async writeProjectTracking(remove = false): Promise<() => Promise<void>> {
    const { paths, originals, manifest, hooks } = await this.projectTrackingFiles();
    const owned = (handler: any) => typeof handler?.command === "string" && handler.command.includes("multivibe-project-hook.mjs");
    const groups = (hooks.SessionStart ?? []).flatMap((group: any) => {
      if (!Array.isArray(group?.hooks) || !group.hooks.some(owned)) return [group];
      const remaining = group.hooks.filter((handler: any) => !owned(handler));
      return remaining.length ? [{ ...group, hooks: remaining }] : [];
    });
    const quote = (value: string) => process.platform === "win32" ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, `'"'"'`)}'`;
    if (!remove) groups.push({ matcher: "startup|resume|clear|compact", hooks: [{
      type: "command", command: `${quote(process.execPath)} ${quote(paths[2])} --config ${quote(paths[1])}`,
      timeout: 2, statusMessage: "Identifying Codex project",
    }] });
    hooks.SessionStart = groups;
    manifest.hooks = hooks;
    const restore = async () => {
      for (let i = 0; i < paths.length; i++) {
        const original = originals[i];
        if (original) await writeAtomic(paths[i], original.content, original.mode);
        else await fs.rm(paths[i], { force: true });
      }
    };
    try {
      if (!remove) {
        const source = await fs.readFile(fileURLToPath(new URL("../../scripts/codex-project-hook.mjs", import.meta.url)), "utf8");
        await writeAtomic(paths[2], source, 0o700);
        await writeAtomic(paths[1], `${JSON.stringify({ url: this.baseUrl, token: this.projectRegistrationToken }, null, 2)}\n`, 0o600);
      }
      if (!remove || originals[0]) await writeAtomic(paths[0], `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
      // Only remove our credentials and executable when the saved destination belongs to this Host.
      if (remove && originals[1]) {
        const config = JSON.parse(originals[1].content);
        if (config.url === this.baseUrl && config.token === this.projectRegistrationToken) {
          await fs.rm(paths[1], { force: true });
          await fs.rm(paths[2], { force: true });
        }
      }
    } catch (error) { await restore(); throw error; }
    return restore;
  }

  private async projectTrackingStatus(): Promise<"installed" | "not-installed" | "unavailable"> {
    if (!this.projectRegistrationToken) return "unavailable";
    try {
      const { paths, originals, hooks } = await this.projectTrackingFiles();
      const config = JSON.parse(originals[1]?.content ?? "{}");
      const source = await fs.readFile(fileURLToPath(new URL("../../scripts/codex-project-hook.mjs", import.meta.url)), "utf8");
      return config.url === this.baseUrl && config.token === this.projectRegistrationToken && originals[2]?.content === source &&
        (hooks.SessionStart ?? []).some((group: any) => group?.hooks?.some((handler: any) =>
          handler.type === "command" && handler.command?.includes(paths[2]) && handler.command?.includes(paths[1])))
        ? "installed" : "not-installed";
    } catch { return "not-installed"; }
  }

  async install(id: string, credential: { apiKeyId: string; apiKey: string; application: string }): Promise<HostHarnessView> {
    return this.serial(async () => {
      const definition = this.definition(id);
      if (!definition.configuration) {
        throw new HostHarnessIntegrationError(definition.unavailableReason ?? manualReason, 409);
      }
      const state = await this.readState();
      const before = await this.view(definition, state);
      if (!before.detected) throw new HostHarnessIntegrationError(`${definition.name} is not installed on this host`, 409);
      if (before.managed) {
        if (!before.drifted) return before;
        throw new HostHarnessIntegrationError(`${definition.name} has drifted; repair the existing integration before reconnecting it`, 409);
      }
      if (before.configured) return before;

      const configPath = await this.safeConfigPath(definition.configuration.relativePath);
      const original = await readBounded(configPath);
      const context: HarnessContext = {
        baseUrl: this.baseUrl,
        apiKey: credential.apiKey,
      };
      const preparedContext = definition.configuration.prepare
        ? { ...context, ...(await definition.configuration.prepare(context)) }
        : context;
      const installed = definition.configuration.render(original?.content ?? null, preparedContext);
      await writeAtomic(configPath, installed, 0o600);
      state.installations[id] = {
        configPath,
        originalContentBase64: original ? Buffer.from(original.content).toString("base64") : null,
        originalMode: original?.mode ?? null,
        installedSha256: sha256(installed),
        apiKeyId: credential.apiKeyId,
        application: credential.application,
        installedAt: Date.now(),
        ...(definition.configuration.revision
          ? { configurationRevision: definition.configuration.revision }
          : {}),
      };
      let restoreTracking: (() => Promise<void>) | undefined;
      try {
        if (id === "openai-codex" && this.projectRegistrationToken) restoreTracking = await this.writeProjectTracking();
        await this.writeState(state);
      } catch (error) {
        await restoreTracking?.();
        if (original) await writeAtomic(configPath, original.content, original.mode);
        else await fs.unlink(configPath).catch(() => undefined);
        throw error;
      }
      return this.view(definition, state);
    });
  }

  async repair(id: string, credential: { apiKeyId: string; apiKey: string; application: string }): Promise<HostHarnessView> {
    return this.serial(async () => {
      const definition = this.definition(id);
      if (!definition.configuration) {
        throw new HostHarnessIntegrationError(definition.unavailableReason ?? manualReason, 409);
      }
      const state = await this.readState();
      const installation = state.installations[id];
      if (!installation) throw new HostHarnessIntegrationError(`${definition.name} is not managed by MultiVibe Host`, 409);
      const configPath = await this.safeConfigPath(definition.configuration.relativePath);
      const current = await readBounded(configPath);
      if (!current) throw new HostHarnessIntegrationError(`~/${definition.configuration.relativePath} is missing`, 409);
      const inspection = definition.configuration.inspect
        ? definition.configuration.inspect(current.content, this.baseUrl)
        : { configured: false, repairable: true };
      if (!inspection.repairable) {
        throw new HostHarnessIntegrationError(inspection.configurationIssue ?? `~/${definition.configuration.relativePath} cannot be repaired safely`, 409);
      }
      const context: HarnessContext = {
        baseUrl: this.baseUrl,
        apiKey: credential.apiKey,
      };
      const preparedContext = definition.configuration.prepare
        ? { ...context, ...(await definition.configuration.prepare(context)) }
        : context;
      const repaired = definition.configuration.render(current.content, preparedContext);
      await writeAtomic(configPath, repaired, current.mode);
      let restoreTracking: (() => Promise<void>) | undefined;
      try {
        if (id === "openai-codex" && this.projectRegistrationToken) restoreTracking = await this.writeProjectTracking();
        state.installations[id] = {
          ...installation,
          installedSha256: sha256(repaired),
          apiKeyId: credential.apiKeyId,
          application: credential.application,
          installedAt: Date.now(),
          ...(definition.configuration.revision
            ? { configurationRevision: definition.configuration.revision }
            : {}),
        };
        await this.writeState(state);
      } catch (error) {
        await restoreTracking?.();
        await writeAtomic(configPath, current.content, current.mode);
        throw error;
      }
      return this.view(definition, state);
    });
  }

  async uninstall(id: string): Promise<{ view: HostHarnessView; apiKeyId: string | null }> {
    return this.serial(async () => {
      const definition = this.definition(id);
      const state = await this.readState();
      const installation = state.installations[id];
      if (!installation) {
        return { view: await this.view(definition, state), apiKeyId: null };
      }
      const configPath = await this.safeConfigPath(definition.configuration?.relativePath ?? "");
      if (configPath !== installation.configPath) {
        throw new HostHarnessIntegrationError("the saved harness configuration path is invalid", 409);
      }
      const current = await readBounded(configPath);
      if (!current || sha256(current.content) !== installation.installedSha256) {
        throw new HostHarnessIntegrationError(`~/${definition.configuration!.relativePath} changed after MultiVibe was installed; it was left untouched`, 409);
      }
      const restoreTracking = id === "openai-codex" ? await this.writeProjectTracking(true) : undefined;
      try {
        if (installation.originalContentBase64 === null) {
          await fs.unlink(configPath);
        } else {
          const original = Buffer.from(installation.originalContentBase64, "base64").toString("utf8");
          await writeAtomic(configPath, original, installation.originalMode ?? 0o600);
        }
        delete state.installations[id];
        await this.writeState(state);
      } catch (error) {
        await restoreTracking?.();
        await writeAtomic(configPath, current.content, current.mode);
        throw error;
      }
      return { view: await this.view(definition, state), apiKeyId: installation.apiKeyId };
    });
  }

  private definition(id: string): HostHarnessDefinition {
    const found = this.definitions.find((entry) => entry.id === id);
    if (!found) throw new HostHarnessIntegrationError("unknown harness", 404);
    return found;
  }

  private async view(definition: HostHarnessDefinition, state: HarnessState): Promise<HostHarnessView> {
    const detectedBy: string[] = [];
    for (const executable of definition.executables) {
      for (const rawDirectory of this.executableDirectories) {
        const directory = rawDirectory.startsWith("/") ? rawDirectory : path.join(this.homeDirectory, rawDirectory);
        if (await footprintExists(this.homeDirectory, path.join(directory, executable))) {
          detectedBy.push(`command:${executable}`);
          break;
        }
      }
    }
    for (const footprint of definition.footprints) {
      if (await footprintExists(this.homeDirectory, footprint)) detectedBy.push(`path:~/${footprint}`);
    }
    const installation = state.installations[definition.id];
    const detected = detectedBy.length > 0 || Boolean(installation);
    let configured = false;
    let drifted = false;
    let repairable = false;
    let configurationError: string | undefined;
    let configurationIssue: string | undefined;
    let effectiveProvider: string | undefined;
    let effectiveBaseUrl: string | undefined;
    let configurationFileChanged = Boolean(installation);
    let configurationRevisionChanged = false;
    if (definition.configuration) {
      try {
        const configPath = await this.safeConfigPath(definition.configuration.relativePath);
        const current = await readBounded(configPath);
        if (current) {
          const inspection = definition.configuration.inspect
            ? definition.configuration.inspect(
                current.content,
                this.baseUrl,
                installation ? this.apiKeyForId(installation.apiKeyId) : undefined,
              )
            : {
                configured: definition.configuration.isConfigured(current.content, this.baseUrl),
                repairable: true,
              };
          configured = inspection.configured;
          repairable = inspection.repairable;
          configurationIssue = inspection.configurationIssue;
          effectiveProvider = inspection.effectiveProvider;
          effectiveBaseUrl = inspection.effectiveBaseUrl;
        }
        configurationFileChanged = Boolean(
          installation && (!current || sha256(current.content) !== installation.installedSha256),
        );
        configurationRevisionChanged = Boolean(
          installation &&
            definition.configuration.revision !== undefined &&
            installation.configurationRevision !== definition.configuration.revision,
        );
        drifted = Boolean(
          installation &&
            (!current ||
              configurationRevisionChanged ||
              (definition.configuration.driftScope === "managed"
                ? !configured
                : configurationFileChanged)),
        );
      } catch (error: any) {
        configurationError = error?.message ?? "The harness configuration cannot be edited safely.";
        drifted = Boolean(installation);
        configurationFileChanged = Boolean(installation);
      }
    }
    return {
      id: definition.id,
      name: definition.name,
      category: definition.category,
      detected,
      detectedBy: Array.from(new Set(detectedBy)),
      ...(definition.id === "openai-codex" ? { projectTracking: await this.projectTrackingStatus() } : {}),
      configured,
      managed: Boolean(installation),
      drifted,
      canInstall: detected && Boolean(definition.configuration) && !configured && !installation && !configurationError,
      repairable: Boolean(installation && repairable && !configurationError),
      canUninstall: Boolean(installation) && !configurationFileChanged && !configurationRevisionChanged && !configurationError,
      ...(definition.configuration ? { configPath: `~/${definition.configuration.relativePath}` } : {}),
      ...(configurationIssue ? { configurationIssue } : {}),
      ...(effectiveProvider ? { effectiveProvider } : {}),
      ...(effectiveBaseUrl ? { effectiveBaseUrl } : {}),
      ...(!definition.configuration || configurationError
        ? { unavailableReason: configurationError ?? definition.unavailableReason ?? manualReason }
        : {}),
    };
  }

  private async safeConfigPath(relativePath: string): Promise<string> {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(path.sep).includes("..")) {
      throw new HostHarnessIntegrationError("unsafe harness configuration path", 409);
    }
    const candidate = path.resolve(this.homeDirectory, relativePath);
    if (!isInside(this.homeDirectory, candidate)) {
      throw new HostHarnessIntegrationError("harness configuration escapes the user's home directory", 409);
    }
    let ancestor = path.dirname(candidate);
    while (ancestor !== this.homeDirectory) {
      try {
        const resolved = await fs.realpath(ancestor);
        const home = await fs.realpath(this.homeDirectory);
        if (!isInside(home, resolved)) throw new HostHarnessIntegrationError("harness configuration parent escapes the user's home directory", 409);
        break;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        ancestor = path.dirname(ancestor);
      }
    }
    return candidate;
  }

  private async readState(): Promise<HarnessState> {
    const file = await readBounded(this.statePath);
    if (!file) return { schemaVersion: STATE_SCHEMA_VERSION, installations: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.content);
    } catch {
      throw new HostHarnessIntegrationError("the harness integration state is invalid", 500);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HostHarnessIntegrationError("the harness integration state is invalid", 500);
    }
    const state = parsed as HarnessState;
    if (state.schemaVersion !== STATE_SCHEMA_VERSION || !state.installations || typeof state.installations !== "object" || Array.isArray(state.installations)) {
      throw new HostHarnessIntegrationError("the harness integration state has an unsupported schema", 500);
    }
    return state;
  }

  private async writeState(state: HarnessState) {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    await writeAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operation.then(operation, operation);
    this.operation = run.then(() => undefined, () => undefined);
    return run;
  }
}
