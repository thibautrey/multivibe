import type { ModuleManifest, MultivibeModule } from "./module-sdk.js";

export const HEADROOM_PLUGIN = "multivibe.headroom";
export const HEADROOM_DEFAULT_IMAGE = "ghcr.io/headroomlabs-ai/headroom:latest";
export const HEADROOM_CONTAINER_NAME = "multivibe-headroom";
export const HEADROOM_VOLUME_NAME = "multivibe-headroom-state";
export const HEADROOM_PORT = 8787;

export const HEADROOM_MODES = ["", "lossless", "lossy_inline", "lossless_then_lossy"] as const;

export type HeadroomMode = (typeof HEADROOM_MODES)[number];

export type HeadroomSettings = {
  /** Provision and own the Docker container (recommended). */
  manageContainer: boolean;
  /** Manual endpoint used when container management is off. */
  serverUrl: string;
  mode: HeadroomMode;
  timeoutMs: number;
  minBytes: number;
  image: string;
};

export type HeadroomPublicSettings = HeadroomSettings & {
  /** A proxy token is stored outside the module settings (state file, mode 0600). */
  hasProxyToken: boolean;
};

export const HEADROOM_DEFAULT_SETTINGS: HeadroomSettings = {
  manageContainer: true,
  serverUrl: "",
  mode: "",
  timeoutMs: 3_000,
  minBytes: 4_096,
  image: HEADROOM_DEFAULT_IMAGE,
};

const text = (title: string, description: string) => ({
  type: "string",
  title,
  description,
});

export const headroomPluginManifest: ModuleManifest = {
  id: HEADROOM_PLUGIN,
  name: "Headroom compression",
  version: "1.0.0",
  apiVersion: 1,
  description:
    "Shrink provider-ready request bodies with a managed Headroom sidecar before the edge sends them upstream. Routing, authentication and quota stay in MultiVibe.",
  repository: "https://github.com/headroomlabs-ai/headroom",
  entrypoint: "headroom-plugin.js",
  hooks: [],
  categories: ["Performance"],
  tags: ["compression", "context", "headroom", "docker"],
  defaultEnabled: false,
  defaultSettings: { ...HEADROOM_DEFAULT_SETTINGS },
  settingsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      manageContainer: {
        type: "boolean",
        title: "Manage the Docker container",
        description:
          "Let MultiVibe pull, start, stop and remove the Headroom container. Turn off to point at an existing service.",
      },
      serverUrl: {
        ...text(
          "Manual Headroom URL",
          "Used only when container management is off. A base URL is normalized to /v1/compress.",
        ),
      },
      mode: {
        type: "string",
        title: "Compression mode",
        description: "Marker-free modes only; CCR is rejected because MultiVibe never redeems retrieval markers.",
        enum: [...HEADROOM_MODES],
      },
      timeoutMs: {
        type: "integer",
        title: "Timeout (ms)",
        description: "Compression is skipped, and the original body is sent, when Headroom is slower than this.",
        minimum: 50,
        maximum: 30_000,
      },
      minBytes: {
        type: "integer",
        title: "Minimum payload (bytes)",
        description: "Smaller provider-ready bodies skip the round trip entirely.",
        minimum: 0,
        maximum: 1_048_576,
      },
      image: {
        ...text(
          "Container image",
          "Advanced. CI keeps the contract pinned; moving tags may change behavior without notice.",
        ),
      },
    },
  },
};

/** No request hooks: compression is applied by the Rust edge, not the module sandbox. */
export function createHeadroomPlugin(): MultivibeModule {
  return {};
}

export function headroomSettings(raw: Record<string, unknown> | undefined): HeadroomSettings {
  const value = raw ?? {};
  const mode = String(value.mode ?? "");
  const timeout = Number(value.timeoutMs);
  const minBytes = Number(value.minBytes);
  return {
    manageContainer:
      typeof value.manageContainer === "boolean"
        ? value.manageContainer
        : HEADROOM_DEFAULT_SETTINGS.manageContainer,
    serverUrl: typeof value.serverUrl === "string" ? value.serverUrl.trim() : "",
    mode: (HEADROOM_MODES as readonly string[]).includes(mode) ? (mode as HeadroomMode) : "",
    timeoutMs: Number.isFinite(timeout)
      ? Math.min(30_000, Math.max(50, Math.round(timeout)))
      : HEADROOM_DEFAULT_SETTINGS.timeoutMs,
    minBytes: Number.isFinite(minBytes)
      ? Math.min(1_048_576, Math.max(0, Math.round(minBytes)))
      : HEADROOM_DEFAULT_SETTINGS.minBytes,
    image:
      typeof value.image === "string" && value.image.trim()
        ? value.image.trim()
        : HEADROOM_DEFAULT_SETTINGS.image,
  };
}

export function publicHeadroomSettings(
  settings: HeadroomSettings,
  hasProxyToken: boolean,
): HeadroomPublicSettings {
  return { ...settings, hasProxyToken };
}
