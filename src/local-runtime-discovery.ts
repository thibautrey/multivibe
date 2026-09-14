import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { trustedCopilotBaseUrl } from "./github-copilot.js";
import { sdkAdapterBaseUrl, SDK_INTERNAL_TOKEN } from "./ai-sdk/connection.js";
import { openCodeInferenceToken } from "./opencode.js";
import type {
  Account,
  LocalRuntimeAdapterId,
  LocalRuntimeMetadata,
} from "./types.js";
import type { AccountStore } from "./store.js";

export const LOCAL_RUNTIME_DISCOVERY_TIMEOUT_MS = 1_500;
export const LOCAL_RUNTIME_MAX_RESPONSE_BYTES = 256 * 1024;
export const LOCAL_RUNTIME_MAX_FILESYSTEM_ENTRIES = 50_000;
export const OLLAMA_ALLOWED_PORTS = [11434] as const;
export const LM_STUDIO_ALLOWED_PORTS = [1234] as const;
export const OMLX_ALLOWED_PORTS = [8000] as const;
export const EXO_ALLOWED_PORTS = [52415] as const;
export const MTPLX_ALLOWED_PORTS = [8000] as const;
export const JAN_ALLOWED_PORTS = [1337] as const;
export const GPT4ALL_ALLOWED_PORTS = [4891] as const;
export const KOBOLDCPP_ALLOWED_PORTS = [5001] as const;
export const XINFERENCE_ALLOWED_PORTS = [9997] as const;
export const SGLANG_ALLOWED_PORTS = [30000] as const;
export const APHRODITE_ALLOWED_PORTS = [2242] as const;

const OLLAMA_ORIGINS = [
  "http://127.0.0.1:11434",
  "http://[::1]:11434",
] as const;
const LM_STUDIO_ORIGINS = [
  "http://127.0.0.1:1234",
  "http://[::1]:1234",
] as const;
const OMLX_ORIGINS = ["http://127.0.0.1:8000", "http://[::1]:8000"] as const;
const EXO_ORIGINS = ["http://127.0.0.1:52415", "http://[::1]:52415"] as const;
const MTPLX_ORIGINS = ["http://127.0.0.1:8000", "http://[::1]:8000"] as const;
function loopbackOrigins(port: number) {
  return [`http://127.0.0.1:${port}`, `http://[::1]:${port}`] as const;
}
const JAN_ORIGINS = loopbackOrigins(1337);
const GPT4ALL_ORIGINS = loopbackOrigins(4891);
const KOBOLDCPP_ORIGINS = loopbackOrigins(5001);
const XINFERENCE_ORIGINS = loopbackOrigins(9997);
const SGLANG_ORIGINS = loopbackOrigins(30000);
const APHRODITE_ORIGINS = loopbackOrigins(2242);
const OPENAI_COMPATIBLE_REQUEST_PATHS = [
  "/models",
  "/v1/models",
  "/v1/responses",
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
] as const;
const LOOPBACK_OPENAI_REQUEST_PATHS: ReadonlySet<string> = new Set(
  OPENAI_COMPATIBLE_REQUEST_PATHS.filter((path) => path !== "/models"),
);
const EXO_REQUEST_PATHS: ReadonlySet<string> = new Set(
  OPENAI_COMPATIBLE_REQUEST_PATHS,
);

type AutomaticLocalRuntimeAdapterId =
  | "ollama"
  | "lm-studio"
  | "omlx"
  | "exo"
  | "mtplx"
  | "jan"
  | "gpt4all"
  | "koboldcpp"
  | "xinference"
  | "sglang"
  | "aphrodite";

const AUTOMATIC_LOCAL_RUNTIME_BOUNDARIES = {
  ollama: {
    name: "Ollama",
    origins: OLLAMA_ORIGINS,
    ports: OLLAMA_ALLOWED_PORTS,
    catalogPath: "/v1/models",
    requestPaths: LOOPBACK_OPENAI_REQUEST_PATHS,
  },
  "lm-studio": {
    name: "LM Studio",
    origins: LM_STUDIO_ORIGINS,
    ports: LM_STUDIO_ALLOWED_PORTS,
    catalogPath: "/v1/models",
    requestPaths: LOOPBACK_OPENAI_REQUEST_PATHS,
  },
  omlx: {
    name: "OMLX",
    origins: OMLX_ORIGINS,
    ports: OMLX_ALLOWED_PORTS,
    catalogPath: "/v1/models",
    requestPaths: LOOPBACK_OPENAI_REQUEST_PATHS,
  },
  exo: {
    name: "Exo",
    origins: EXO_ORIGINS,
    ports: EXO_ALLOWED_PORTS,
    catalogPath: "/models",
    requestPaths: EXO_REQUEST_PATHS,
  },
  mtplx: {
    name: "MTPLX",
    origins: MTPLX_ORIGINS,
    ports: MTPLX_ALLOWED_PORTS,
    catalogPath: "/v1/models",
    requestPaths: LOOPBACK_OPENAI_REQUEST_PATHS,
  },
  jan: {
    name: "Jan",
    origins: JAN_ORIGINS,
    ports: JAN_ALLOWED_PORTS,
    catalogPath: "/v1/models",
    requestPaths: LOOPBACK_OPENAI_REQUEST_PATHS,
  },
  gpt4all: {
    name: "GPT4All",
    origins: GPT4ALL_ORIGINS,
    ports: GPT4ALL_ALLOWED_PORTS,
    catalogPath: "/v1/models",
    requestPaths: LOOPBACK_OPENAI_REQUEST_PATHS,
  },
  koboldcpp: {
    name: "KoboldCpp",
    origins: KOBOLDCPP_ORIGINS,
    ports: KOBOLDCPP_ALLOWED_PORTS,
    catalogPath: "/v1/models",
    requestPaths: LOOPBACK_OPENAI_REQUEST_PATHS,
  },
  xinference: {
    name: "Xinference",
    origins: XINFERENCE_ORIGINS,
    ports: XINFERENCE_ALLOWED_PORTS,
    catalogPath: "/v1/models",
    requestPaths: LOOPBACK_OPENAI_REQUEST_PATHS,
  },
  sglang: {
    name: "SGLang",
    origins: SGLANG_ORIGINS,
    ports: SGLANG_ALLOWED_PORTS,
    catalogPath: "/v1/models",
    requestPaths: LOOPBACK_OPENAI_REQUEST_PATHS,
  },
  aphrodite: {
    name: "Aphrodite",
    origins: APHRODITE_ORIGINS,
    ports: APHRODITE_ALLOWED_PORTS,
    catalogPath: "/v1/models",
    requestPaths: LOOPBACK_OPENAI_REQUEST_PATHS,
  },
} as const;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type LocalRuntimeCandidate = {
  endpoint: string;
  modelsUrl: string;
};

export type LocalRuntimeAdapter = {
  id: LocalRuntimeAdapterId;
  displayName: string;
  protocol: "openai-compatible" | "native";
  healthPath: string;
  catalogPath: string;
  capabilities: readonly (
    | "text"
    | "embeddings"
    | "image"
    | "audio"
    | "tools"
  )[];
  authentication: "none" | "optional-bearer" | "required-bearer";
  measurement: readonly (
    | "input_text_token"
    | "output_text_token"
    | "request"
    | "runtime_metrics"
  )[];
  limits: {
    maxCatalogModels: number;
    maxResponseBytes: number;
    timeoutMs: number;
  };
  candidates: readonly LocalRuntimeCandidate[];
};

const DEFAULT_ADAPTER_CONTRACT = {
  protocol: "openai-compatible" as const,
  healthPath: "/v1/models",
  catalogPath: "/v1/models",
  capabilities: ["text", "embeddings", "tools"] as const,
  authentication: "optional-bearer" as const,
  measurement: ["input_text_token", "output_text_token", "request"] as const,
  limits: {
    maxCatalogModels: 10_000,
    maxResponseBytes: LOCAL_RUNTIME_MAX_RESPONSE_BYTES,
    timeoutMs: LOCAL_RUNTIME_DISCOVERY_TIMEOUT_MS,
  },
};

function registeredAdapter(
  id: LocalRuntimeAdapterId,
  displayName: string,
): LocalRuntimeAdapter {
  return { id, displayName, ...DEFAULT_ADAPTER_CONTRACT, candidates: [] };
}
function automaticAdapter(
  id: AutomaticLocalRuntimeAdapterId,
  displayName: string,
  origins: readonly string[],
): LocalRuntimeAdapter {
  return {
    id,
    displayName,
    ...DEFAULT_ADAPTER_CONTRACT,
    authentication: "none",
    candidates: origins.map((endpoint) => ({
      endpoint,
      modelsUrl: `${endpoint}/v1/models`,
    })),
  };
}
export const LOCAL_RUNTIME_ADAPTERS: readonly LocalRuntimeAdapter[] = [
  {
    id: "ollama",
    displayName: "Ollama",
    ...DEFAULT_ADAPTER_CONTRACT,
    authentication: "none",
    candidates: [
      {
        endpoint: "http://127.0.0.1:11434",
        modelsUrl: "http://127.0.0.1:11434/v1/models",
      },
      {
        endpoint: "http://[::1]:11434",
        modelsUrl: "http://[::1]:11434/v1/models",
      },
    ],
  },
  {
    id: "lm-studio",
    displayName: "LM Studio",
    ...DEFAULT_ADAPTER_CONTRACT,
    authentication: "none",
    candidates: [
      {
        endpoint: "http://127.0.0.1:1234",
        modelsUrl: "http://127.0.0.1:1234/v1/models",
      },
      {
        endpoint: "http://[::1]:1234",
        modelsUrl: "http://[::1]:1234/v1/models",
      },
    ],
  },
  registeredAdapter("llama-cpp", "llama.cpp / llama-server / llama-cpp-python"),
  registeredAdapter("vllm", "vLLM"),
  automaticAdapter("sglang", "SGLang", SGLANG_ORIGINS),
  registeredAdapter("localai", "LocalAI"),
  registeredAdapter("huggingface-tgi", "Hugging Face TGI"),
  registeredAdapter("transformers-serve", "Transformers Serve"),
  automaticAdapter("xinference", "Xinference", XINFERENCE_ORIGINS),
  registeredAdapter("mlx-lm", "MLX-LM"),
  {
    id: "omlx",
    displayName: "OMLX",
    ...DEFAULT_ADAPTER_CONTRACT,
    authentication: "none",
    candidates: [
      {
        endpoint: "http://127.0.0.1:8000",
        modelsUrl: "http://127.0.0.1:8000/v1/models",
      },
      {
        endpoint: "http://[::1]:8000",
        modelsUrl: "http://[::1]:8000/v1/models",
      },
    ],
  },
  registeredAdapter("mlc-llm", "MLC LLM"),
  {
    id: "exo",
    displayName: "Exo",
    ...DEFAULT_ADAPTER_CONTRACT,
    healthPath: "/models",
    catalogPath: "/models",
    authentication: "none",
    candidates: [
      {
        endpoint: "http://127.0.0.1:52415",
        modelsUrl: "http://127.0.0.1:52415/models",
      },
      {
        endpoint: "http://[::1]:52415",
        modelsUrl: "http://[::1]:52415/models",
      },
    ],
  },
  automaticAdapter("jan", "Jan", JAN_ORIGINS),
  automaticAdapter("gpt4all", "GPT4All", GPT4ALL_ORIGINS),
  automaticAdapter("koboldcpp", "KoboldCpp", KOBOLDCPP_ORIGINS),
  registeredAdapter("text-generation-webui", "text-generation-webui"),
  automaticAdapter("aphrodite", "Aphrodite", APHRODITE_ORIGINS),
  registeredAdapter("tabbyapi", "TabbyAPI"),
  registeredAdapter("llama-box", "llama-box"),
  registeredAdapter("mistral-rs", "mistral.rs"),
  registeredAdapter("nvidia-nim", "NVIDIA NIM"),
  registeredAdapter("tensorrt-llm", "TensorRT-LLM"),
  registeredAdapter("triton", "NVIDIA Triton"),
  registeredAdapter("openllm", "OpenLLM"),
  registeredAdapter("bentoml", "BentoML"),
  {
    id: "mtplx",
    displayName: "MTPLX",
    ...DEFAULT_ADAPTER_CONTRACT,
    authentication: "none",
    candidates: [
      {
        endpoint: "http://127.0.0.1:8000",
        modelsUrl: "http://127.0.0.1:8000/v1/models",
      },
      {
        endpoint: "http://[::1]:8000",
        modelsUrl: "http://[::1]:8000/v1/models",
      },
    ],
  },
  {
    ...registeredAdapter("nvidia-pair", "NVIDIA Personal AI Router (PAIR)"),
    authentication: "none",
  },
  registeredAdapter(
    "manual-openai-compatible",
    "Manual OpenAI-compatible server",
  ),
];

export type LocalRuntimeProbeSuccess = {
  status: "discovered";
  adapter: LocalRuntimeAdapterId;
  displayName: string;
  endpoint: string;
  confirmedModelIds: string[];
  discoveryMethod: "api" | "filesystem";
};

export type LocalRuntimeProbeUnavailable = {
  status: "unavailable" | "not-configured";
  adapter: LocalRuntimeAdapterId;
  displayName: string;
  attempts: number;
  error?: string;
};

export type LocalRuntimeProbeResult =
  | LocalRuntimeProbeSuccess
  | LocalRuntimeProbeUnavailable;

export type LocalRuntimeDiscoveryOptions = {
  fetchFn?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
  adapters?: readonly LocalRuntimeAdapter[];
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  filesystem?: Pick<typeof fs, "readdir" | "readFile">;
};

function isAutomaticLocalRuntimeAdapterId(
  id: LocalRuntimeAdapterId,
): id is AutomaticLocalRuntimeAdapterId {
  return (
    id === "ollama" ||
    id === "lm-studio" ||
    id === "omlx" ||
    id === "exo" ||
    id === "mtplx" ||
    id === "jan" ||
    id === "gpt4all" ||
    id === "koboldcpp" ||
    id === "xinference" ||
    id === "sglang" ||
    id === "aphrodite"
  );
}

function automaticRuntimeBoundary(id: AutomaticLocalRuntimeAdapterId) {
  return AUTOMATIC_LOCAL_RUNTIME_BOUNDARIES[id];
}

export function localRuntimeCatalogPath(
  adapter: LocalRuntimeAdapterId,
): string {
  return isAutomaticLocalRuntimeAdapterId(adapter)
    ? automaticRuntimeBoundary(adapter).catalogPath
    : "/v1/models";
}

function automaticRuntimeSignature(
  id: AutomaticLocalRuntimeAdapterId,
): { ownedBy: string } | undefined {
  if (id === "omlx" || id === "mtplx" || id === "exo") {
    return { ownedBy: id };
  }
  return undefined;
}

function hasExactAutomaticRuntimeOrigin(
  id: AutomaticLocalRuntimeAdapterId,
  raw: string,
): boolean {
  return AUTOMATIC_LOCAL_RUNTIME_BOUNDARIES[id].origins.some(
    (origin) => raw === origin || raw === `${origin}/`,
  );
}

function parseAutomaticRuntimeEndpoint(
  id: AutomaticLocalRuntimeAdapterId,
  raw: string,
): URL {
  const boundary = AUTOMATIC_LOCAL_RUNTIME_BOUNDARIES[id];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("local runtime endpoint must be a valid URL");
  }
  if (
    !hasExactAutomaticRuntimeOrigin(id, raw) ||
    url.protocol !== "http:" ||
    !(boundary.ports as readonly number[]).includes(Number(url.port)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      `${boundary.name} endpoint must be credential-free HTTP on 127.0.0.1 or ::1 port ${boundary.ports.join(" or ")}`,
    );
  }
  return url;
}

function parseAutomaticRuntimeRequestUrl(
  id: AutomaticLocalRuntimeAdapterId,
  raw: string,
): URL {
  const boundary = AUTOMATIC_LOCAL_RUNTIME_BOUNDARIES[id];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("local runtime request must use a valid URL");
  }
  const hasExactRequestUrl = boundary.origins.some(
    (origin) =>
      boundary.requestPaths.has(raw.slice(origin.length)) &&
      raw === `${origin}${url.pathname}`,
  );
  if (
    !hasExactRequestUrl ||
    url.protocol !== "http:" ||
    !(boundary.ports as readonly number[]).includes(Number(url.port)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !boundary.requestPaths.has(url.pathname)
  ) {
    throw new Error(
      `request is outside the discovered ${boundary.name} API boundary`,
    );
  }
  return url;
}

function validConfirmedModelIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 10_000 &&
    value.every(
      (id) =>
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= 512 &&
        id.trim() === id &&
        !/[\u0000-\u001f\u007f]/.test(id),
    )
  );
}

export function isDiscoveredLocalRuntimeAccount(account: Account): boolean {
  if (
    account.provider !== "openai-compatible" ||
    account.location !== "local" ||
    account.accessToken !== "" ||
    account.localRuntime?.source !== "multivibe-local-discovery" ||
    account.localRuntime.authentication !== "none" ||
    !account.baseUrl ||
    !validConfirmedModelIds(account.localRuntime.confirmedModelIds)
  ) {
    return false;
  }
  const adapter = account.localRuntime.adapter;
  if (!isAutomaticLocalRuntimeAdapterId(adapter)) return false;
  try {
    const baseUrl = parseAutomaticRuntimeEndpoint(adapter, account.baseUrl);
    const endpoint = parseAutomaticRuntimeEndpoint(
      adapter,
      account.localRuntime.endpoint,
    );
    return baseUrl.origin === endpoint.origin;
  } catch {
    return false;
  }
}

function parseNvidiaPairEndpoint(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "PAIR endpoint must be a loopback HTTP origin with an explicit port",
    );
  }
  return url;
}

export function isConfiguredNvidiaPairAccount(account: Account): boolean {
  if (
    account.id !== "local-runtime-nvidia-pair" ||
    account.provider !== "openai-compatible" ||
    account.location !== "personal-cluster" ||
    account.accessToken !== "" ||
    account.localRuntime?.source !== "multivibe-local-configuration" ||
    account.localRuntime.adapter !== "nvidia-pair" ||
    account.localRuntime.authentication !== "none" ||
    !account.baseUrl ||
    !validConfirmedModelIds(account.localRuntime.confirmedModelIds)
  )
    return false;
  try {
    return (
      parseNvidiaPairEndpoint(account.baseUrl).origin ===
      parseNvidiaPairEndpoint(account.localRuntime.endpoint).origin
    );
  } catch {
    return false;
  }
}

export function authorizationForAccountRequest(
  account: Account,
  requestUrl: string,
): string | undefined {
  if (account.provider === "github-copilot") {
    const url = new URL(requestUrl);
    if (
      url.origin !== trustedCopilotBaseUrl(account.baseUrl) ||
      url.username ||
      url.password ||
      !["/models", "/chat/completions", "/responses"].includes(url.pathname)
    ) {
      throw new Error("GitHub Copilot request is outside its account boundary");
    }
  }
  if (account.provider === "ai-sdk") {
    if (!requestUrl.startsWith(`${sdkAdapterBaseUrl(account)}/v1/`)) {
      throw new Error("SDK adapter request is outside its account boundary");
    }
    return `Bearer ${SDK_INTERNAL_TOKEN}`;
  }
  const token =
    account.provider === "opencode"
      ? openCodeInferenceToken(account)
      : account.accessToken;
  if (token) return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  if (isConfiguredNvidiaPairAccount(account)) {
    const request = new URL(requestUrl);
    const endpoint = parseNvidiaPairEndpoint(account.localRuntime!.endpoint);
    if (
      request.origin !== endpoint.origin ||
      !LOOPBACK_OPENAI_REQUEST_PATHS.has(request.pathname) ||
      request.username ||
      request.password ||
      request.search ||
      request.hash
    )
      throw new Error("request is outside the configured PAIR boundary");
    return undefined;
  }
  if (!isDiscoveredLocalRuntimeAccount(account)) {
    throw new Error(
      "account has no credential and is not a discovered local runtime",
    );
  }
  const adapter = account.localRuntime!
    .adapter as AutomaticLocalRuntimeAdapterId;
  const request = parseAutomaticRuntimeRequestUrl(adapter, requestUrl);
  const endpoint = parseAutomaticRuntimeEndpoint(
    adapter,
    account.localRuntime!.endpoint,
  );
  if (request.origin !== endpoint.origin) {
    throw new Error(
      "request origin does not match the discovered local runtime",
    );
  }
  return undefined;
}

export async function configureNvidiaPairRuntime(
  store: AccountStore,
  endpointInput: string,
  options: LocalRuntimeDiscoveryOptions = {},
): Promise<Account> {
  const endpoint = parseNvidiaPairEndpoint(endpointInput).origin;
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, options.timeoutMs ?? LOCAL_RUNTIME_DISCOVERY_TIMEOUT_MS),
  );
  let confirmedModelIds: string[];
  try {
    const response = await fetchFn(`${endpoint}/v1/models`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status !== 200)
      throw new Error(
        `PAIR model catalog probe returned HTTP ${response.status}`,
      );
    confirmedModelIds = parseModelsPayload(
      await readBoundedJson(
        response,
        options.maxResponseBytes ?? LOCAL_RUNTIME_MAX_RESPONSE_BYTES,
      ),
    );
  } finally {
    clearTimeout(timeout);
  }
  const existing = await store.listAccounts();
  const current = existing.find(
    (account) => account.id === "local-runtime-nvidia-pair",
  );
  if (current && !isConfiguredNvidiaPairAccount(current))
    throw new Error("refusing to replace existing non-PAIR account");
  for (const account of existing) {
    if (
      (account.localRuntime?.adapter === "ollama" ||
        account.localRuntime?.adapter === "lm-studio") &&
      account.localRuntime.source === "multivibe-local-discovery" &&
      account.baseUrl
    ) {
      try {
        if (new URL(account.baseUrl).origin === endpoint)
          await store.deleteAccount(account.id);
      } catch {
        /* ignore malformed legacy URL */
      }
    }
  }
  const account: Account = {
    ...current,
    id: "local-runtime-nvidia-pair",
    provider: "openai-compatible",
    upstreamMode: "chat/completions",
    email: current?.email ?? "NVIDIA Personal AI Router (PAIR)",
    accessToken: "",
    baseUrl: endpoint,
    enabled: current?.enabled ?? true,
    priority: current?.priority ?? 0,
    location: "personal-cluster",
    usage: undefined,
    localRuntime: {
      source: "multivibe-local-configuration",
      adapter: "nvidia-pair",
      endpoint,
      confirmedModelIds,
      authentication: "none",
    },
  };
  await store.addOrUpdate(account);
  return account;
}

function parseModelsPayload(
  value: unknown,
  signature?: { ownedBy: string },
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model catalog must be a JSON object");
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0 || data.length > 10_000) {
    throw new Error("model catalog must contain at least one model");
  }
  const ids = data.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("model catalog entry must be an object");
    }
    const model = entry as { id?: unknown; owned_by?: unknown };
    if (signature && model.owned_by !== signature.ownedBy) {
      throw new Error("model catalog has an invalid runtime signature");
    }
    const id = model.id;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 512 ||
      id.trim() !== id ||
      /[\u0000-\u001f\u007f]/.test(id)
    ) {
      throw new Error("model catalog entry has an invalid id");
    }
    return id;
  });
  return Array.from(new Set(ids));
}

async function readBoundedJson(
  response: Response,
  maxResponseBytes: number,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number(contentLength);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > maxResponseBytes) {
      throw new Error("model catalog response is too large");
    }
  }
  if (!response.body) throw new Error("model catalog response has no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("model catalog response is too large");
    }
    chunks.push(value);
  }

  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
  ).toString("utf8");
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("model catalog response is not valid JSON");
  }
}

export async function probeLocalRuntimeCandidate(
  adapter: LocalRuntimeAdapter,
  candidate: LocalRuntimeCandidate,
  options: LocalRuntimeDiscoveryOptions = {},
): Promise<LocalRuntimeProbeSuccess> {
  const adapterId = adapter.id;
  if (!isAutomaticLocalRuntimeAdapterId(adapterId)) {
    throw new Error(`automatic discovery is not configured for ${adapterId}`);
  }
  const boundary = automaticRuntimeBoundary(adapterId);
  const endpoint = parseAutomaticRuntimeEndpoint(adapterId, candidate.endpoint);
  const modelsUrl = parseAutomaticRuntimeRequestUrl(
    adapterId,
    candidate.modelsUrl,
  );
  if (
    endpoint.origin !== modelsUrl.origin ||
    modelsUrl.pathname !== boundary.catalogPath
  ) {
    throw new Error(
      `model catalog URL does not match the ${boundary.name} endpoint`,
    );
  }

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = Math.max(
    1,
    options.timeoutMs ?? LOCAL_RUNTIME_DISCOVERY_TIMEOUT_MS,
  );
  const maxResponseBytes = Math.max(
    1,
    options.maxResponseBytes ?? LOCAL_RUNTIME_MAX_RESPONSE_BYTES,
  );
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("local runtime probe timed out"));
      controller.abort();
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      (async () => {
        const response = await fetchFn(modelsUrl, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "manual",
          signal: controller.signal,
        });
        if (response.status !== 200) {
          throw new Error(
            `model catalog probe returned HTTP ${response.status}`,
          );
        }
        const confirmedModelIds = parseModelsPayload(
          await readBoundedJson(response, maxResponseBytes),
          automaticRuntimeSignature(adapterId),
        );
        return {
          status: "discovered" as const,
          adapter: adapterId,
          displayName: adapter.displayName,
          endpoint: endpoint.origin,
          confirmedModelIds,
          discoveryMethod: "api" as const,
        };
      })(),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const LOCAL_MODEL_FILE_EXTENSIONS = new Set([
  ".gguf",
  ".safetensors",
  ".bin",
  ".pth",
  ".pt",
  ".onnx",
  ".mlx",
]);

function validDiskModelId(id: string): boolean {
  return (
    validConfirmedModelIds([id]) && !id.startsWith(".") && !id.includes("\\")
  );
}

async function directoryEntries(
  directory: string,
  filesystem: Pick<typeof fs, "readdir" | "readFile">,
): Promise<import("node:fs").Dirent[]> {
  try {
    return await filesystem.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function containsModelFile(
  directory: string,
  filesystem: Pick<typeof fs, "readdir" | "readFile">,
  depth = 2,
): Promise<boolean> {
  for (const entry of await directoryEntries(directory, filesystem)) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);
    if (
      entry.isFile() &&
      (LOCAL_MODEL_FILE_EXTENSIONS.has(
        path.extname(entry.name).toLowerCase(),
      ) ||
        entry.name === "config.json")
    ) {
      return true;
    }
    if (
      depth > 0 &&
      entry.isDirectory() &&
      (await containsModelFile(entryPath, filesystem, depth - 1))
    )
      return true;
  }
  return false;
}

async function discoverOllamaModelsFromDisk(
  options: LocalRuntimeDiscoveryOptions,
): Promise<string[]> {
  const filesystem = options.filesystem ?? fs;
  const home = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const roots = [
    env.OLLAMA_MODELS,
    path.join(home, ".ollama", "models"),
    ...(platform === "linux" ? ["/usr/share/ollama/.ollama/models"] : []),
  ].filter((value): value is string => Boolean(value));
  const models = new Set<string>();
  for (const root of new Set(roots)) {
    const manifests = path.join(root, "manifests");
    for (const registry of await directoryEntries(manifests, filesystem)) {
      if (!registry.isDirectory() || registry.isSymbolicLink()) continue;
      const registryPath = path.join(manifests, registry.name);
      for (const namespace of await directoryEntries(
        registryPath,
        filesystem,
      )) {
        if (!namespace.isDirectory() || namespace.isSymbolicLink()) continue;
        const namespacePath = path.join(registryPath, namespace.name);
        for (const model of await directoryEntries(namespacePath, filesystem)) {
          if (!model.isDirectory() || model.isSymbolicLink()) continue;
          for (const tag of await directoryEntries(
            path.join(namespacePath, model.name),
            filesystem,
          )) {
            if (!tag.isFile() || tag.isSymbolicLink()) continue;
            const prefix =
              namespace.name === "library" ? "" : `${namespace.name}/`;
            const id = `${prefix}${model.name}:${tag.name}`;
            if (validDiskModelId(id)) models.add(id);
            if (models.size >= 10_000) return [...models].sort();
          }
        }
      }
    }
  }
  return [...models].sort();
}

async function discoverTwoLevelModelDirectory(
  roots: readonly string[],
  options: LocalRuntimeDiscoveryOptions,
): Promise<string[]> {
  const filesystem = options.filesystem ?? fs;
  const models = new Set<string>();
  for (const root of new Set(roots)) {
    for (const publisher of await directoryEntries(root, filesystem)) {
      if (
        !publisher.isDirectory() ||
        publisher.isSymbolicLink() ||
        publisher.name.startsWith(".")
      )
        continue;
      const publisherPath = path.join(root, publisher.name);
      for (const model of await directoryEntries(publisherPath, filesystem)) {
        if (
          !model.isDirectory() ||
          model.isSymbolicLink() ||
          model.name.startsWith(".")
        )
          continue;
        if (
          !(await containsModelFile(
            path.join(publisherPath, model.name),
            filesystem,
          ))
        )
          continue;
        const id = `${publisher.name}/${model.name}`;
        if (validDiskModelId(id)) models.add(id);
        if (models.size >= 10_000) return [...models].sort();
      }
    }
  }
  return [...models].sort();
}

function modelIdFromRelativePath(relativePath: string): string | undefined {
  const normalized = relativePath.split(path.sep).filter(Boolean);
  if (normalized.length === 0) return undefined;
  const huggingFace = normalized.find((part) => part.startsWith("models--"));
  if (huggingFace) {
    const id = huggingFace.slice("models--".length).replaceAll("--", "/");
    return validDiskModelId(id) ? id : undefined;
  }
  const filename = normalized.at(-1)!;
  const extension = path.extname(filename).toLowerCase();
  const directoryParts = normalized
    .slice(0, -1)
    .filter((part) => !["snapshots", "blobs"].includes(part));
  const id =
    directoryParts.length > 0
      ? directoryParts.slice(-2).join("/")
      : extension
        ? path.basename(filename, extension)
        : filename;
  return validDiskModelId(id) ? id : undefined;
}

async function discoverFlexibleModelDirectory(
  roots: readonly string[],
  options: LocalRuntimeDiscoveryOptions,
): Promise<string[]> {
  const filesystem = options.filesystem ?? fs;
  const models = new Set<string>();
  let visitedEntries = 0;
  const visit = async (
    root: string,
    directory: string,
    depth: number,
  ): Promise<void> => {
    for (const entry of await directoryEntries(directory, filesystem)) {
      visitedEntries += 1;
      if (
        visitedEntries > LOCAL_RUNTIME_MAX_FILESYSTEM_ENTRIES ||
        models.size >= 10_000 ||
        entry.isSymbolicLink() ||
        entry.name.startsWith(".")
      )
        continue;
      const entryPath = path.join(directory, entry.name);
      if (
        entry.isFile() &&
        LOCAL_MODEL_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        const id = modelIdFromRelativePath(path.relative(root, entryPath));
        if (id) models.add(id);
      } else if (
        entry.isDirectory() &&
        depth > 0 &&
        visitedEntries <= LOCAL_RUNTIME_MAX_FILESYSTEM_ENTRIES
      ) {
        await visit(root, entryPath, depth - 1);
      }
    }
  };
  for (const root of new Set(roots.filter(Boolean))) {
    await visit(root, root, 5);
    if (
      models.size >= 10_000 ||
      visitedEntries > LOCAL_RUNTIME_MAX_FILESYSTEM_ENTRIES
    )
      break;
  }
  return [...models].sort();
}

function platformDataRoots(
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) {
  return {
    applicationSupport:
      platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : undefined,
    config:
      platform === "win32"
        ? env.APPDATA
        : env.XDG_CONFIG_HOME || path.join(home, ".config"),
    data:
      platform === "win32"
        ? env.LOCALAPPDATA
        : env.XDG_DATA_HOME || path.join(home, ".local", "share"),
    cache:
      platform === "win32"
        ? env.LOCALAPPDATA
        : env.XDG_CACHE_HOME || path.join(home, ".cache"),
  };
}

async function gpt4AllModelRoots(
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  filesystem: Pick<typeof fs, "readdir" | "readFile">,
): Promise<string[]> {
  const dirs = platformDataRoots(home, platform, env);
  const roots = [
    env.GPT4ALL_MODEL_PATH,
    path.join(home, ".cache", "gpt4all"),
    dirs.applicationSupport &&
      path.join(dirs.applicationSupport, "nomic.ai", "GPT4All"),
    dirs.data && path.join(dirs.data, "nomic.ai", "GPT4All"),
  ].filter((value): value is string => Boolean(value));
  const configs = [
    dirs.applicationSupport &&
      path.join(dirs.applicationSupport, "nomic.ai", "GPT4All.ini"),
    dirs.config && path.join(dirs.config, "nomic.ai", "GPT4All.ini"),
  ].filter((value): value is string => Boolean(value));
  for (const config of configs) {
    try {
      const raw = await filesystem.readFile(config, "utf8");
      const configured = raw.match(/^modelPath\s*=\s*(.+)$/m)?.[1]?.trim();
      if (configured && path.isAbsolute(configured)) roots.push(configured);
    } catch {
      /* use known defaults */
    }
  }
  return [...new Set(roots)];
}

async function runtimeFilesystemRoots(
  adapter: AutomaticLocalRuntimeAdapterId,
  options: LocalRuntimeDiscoveryOptions,
): Promise<string[]> {
  const home = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const dirs = platformDataRoots(home, platform, env);
  if (adapter === "jan")
    return [
      env.JAN_MODEL_PATH,
      path.join(home, ".jan", "models"),
      path.join(home, "jan", "models"),
      dirs.applicationSupport &&
        path.join(dirs.applicationSupport, "Jan", "data", "models"),
      dirs.config && path.join(dirs.config, "Jan", "data", "models"),
      dirs.data && path.join(dirs.data, "Jan", "data", "models"),
    ].filter((value): value is string => Boolean(value));
  if (adapter === "gpt4all")
    return gpt4AllModelRoots(home, platform, env, options.filesystem ?? fs);
  if (adapter === "xinference")
    return [
      env.XINFERENCE_MODEL_SRC,
      path.join(home, ".xinference", "cache"),
    ].filter((value): value is string => Boolean(value));
  if (adapter === "koboldcpp")
    return [env.KOBOLDCPP_MODELS, env.KOBOLDCPP_MODEL_PATH].filter(
      (value): value is string => Boolean(value),
    );
  if (adapter === "sglang")
    return [env.SGLANG_MODEL_PATH].filter((value): value is string =>
      Boolean(value),
    );
  if (adapter === "aphrodite")
    return [env.APHRODITE_MODEL_PATH].filter((value): value is string =>
      Boolean(value),
    );
  return [];
}

async function lmStudioModelRoots(
  home: string,
  filesystem: Pick<typeof fs, "readdir" | "readFile">,
): Promise<string[]> {
  const roots = [path.join(home, ".lmstudio", "models")];
  try {
    const raw = await filesystem.readFile(
      path.join(home, ".lmstudio", "settings.json"),
      "utf8",
    );
    const configured = (JSON.parse(raw) as { downloadsFolder?: unknown })
      .downloadsFolder;
    if (typeof configured === "string" && path.isAbsolute(configured))
      roots.push(configured);
  } catch {
    // The default model directory remains usable when settings are absent or malformed.
  }
  return [...new Set(roots)];
}

async function discoverInstalledRuntime(
  adapter: LocalRuntimeAdapter,
  options: LocalRuntimeDiscoveryOptions,
): Promise<LocalRuntimeProbeSuccess | undefined> {
  if (
    !isAutomaticLocalRuntimeAdapterId(adapter.id) ||
    adapter.candidates.length === 0
  )
    return undefined;
  const home = options.homeDir ?? os.homedir();
  let confirmedModelIds: string[] = [];
  if (adapter.id === "ollama") {
    confirmedModelIds = await discoverOllamaModelsFromDisk(options);
  } else if (adapter.id === "lm-studio") {
    confirmedModelIds = await discoverTwoLevelModelDirectory(
      await lmStudioModelRoots(home, options.filesystem ?? fs),
      options,
    );
  } else if (adapter.id === "omlx") {
    confirmedModelIds = await discoverTwoLevelModelDirectory(
      [path.join(home, ".omlx", "models")],
      options,
    );
  } else {
    confirmedModelIds = await discoverFlexibleModelDirectory(
      await runtimeFilesystemRoots(adapter.id, options),
      options,
    );
  }
  if (confirmedModelIds.length === 0) return undefined;
  return {
    status: "discovered",
    adapter: adapter.id,
    displayName: adapter.displayName,
    endpoint: new URL(adapter.candidates[0].endpoint).origin,
    confirmedModelIds,
    discoveryMethod: "filesystem",
  };
}

export async function discoverLocalRuntimes(
  options: LocalRuntimeDiscoveryOptions = {},
): Promise<LocalRuntimeProbeResult[]> {
  const adapters = options.adapters ?? LOCAL_RUNTIME_ADAPTERS;
  return Promise.all(
    adapters.map(async (adapter): Promise<LocalRuntimeProbeResult> => {
      if (adapter.candidates.length === 0) {
        return {
          status: "not-configured",
          adapter: adapter.id,
          displayName: adapter.displayName,
          attempts: 0,
        };
      }

      let lastError: string | undefined;
      let discovered: LocalRuntimeProbeSuccess | undefined;
      let attempts = 0;
      for (const candidate of adapter.candidates) {
        attempts += 1;
        try {
          discovered = await probeLocalRuntimeCandidate(
            adapter,
            candidate,
            options,
          );
          break;
        } catch (error: any) {
          lastError = error?.message ?? String(error);
        }
      }

      if (!discovered) {
        try {
          discovered = await discoverInstalledRuntime(adapter, options);
        } catch (error: any) {
          lastError = error?.message ?? String(error);
        }
      }

      return (
        discovered ?? {
          status: "unavailable",
          adapter: adapter.id,
          displayName: adapter.displayName,
          attempts,
          error: lastError,
        }
      );
    }),
  );
}

function discoveredAccountId(adapter: LocalRuntimeAdapterId): string {
  return `local-runtime-${adapter}`;
}

function localRuntimeMetadata(
  result: LocalRuntimeProbeSuccess,
): LocalRuntimeMetadata {
  return {
    source: "multivibe-local-discovery",
    adapter: result.adapter,
    endpoint: result.endpoint,
    confirmedModelIds: result.confirmedModelIds,
    authentication: "none",
  };
}

export async function discoverAndPersistLocalRuntimes(
  store: AccountStore,
  options: LocalRuntimeDiscoveryOptions = {},
): Promise<{ results: LocalRuntimeProbeResult[]; accounts: Account[] }> {
  const results = await discoverLocalRuntimes(options);
  const existingAccounts = await store.listAccounts();
  const pairOrigins = new Set(
    existingAccounts
      .filter(isConfiguredNvidiaPairAccount)
      .map((account) => new URL(account.baseUrl!).origin),
  );
  const accounts: Account[] = [];

  for (const result of results) {
    if (result.status !== "discovered") continue;
    if (
      (result.adapter === "ollama" || result.adapter === "lm-studio") &&
      pairOrigins.has(result.endpoint)
    )
      continue;
    const id = discoveredAccountId(result.adapter);
    const existing = existingAccounts.find((account) => account.id === id);
    if (
      existing &&
      existing.localRuntime?.source !== "multivibe-local-discovery"
    ) {
      throw new Error(
        `refusing to replace existing non-discovered account ${id}`,
      );
    }
    if (existing?.accessToken) {
      throw new Error(
        `refusing to replace credentials on discovered account ${id}`,
      );
    }

    const account: Account = {
      ...existing,
      id,
      provider: "openai-compatible",
      upstreamMode: "chat/completions",
      email: existing?.email ?? `${result.displayName} (local)`,
      accessToken: "",
      baseUrl: result.endpoint,
      enabled: existing?.enabled ?? true,
      priority: existing?.priority ?? 0,
      location: "local",
      usage: undefined,
      localRuntime: localRuntimeMetadata(result),
    };
    await store.addOrUpdate(account);
    accounts.push(account);
  }

  return { results, accounts };
}
