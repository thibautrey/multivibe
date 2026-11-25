import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DockerEngine, resolveDockerSocket, type DockerContainer } from "./headroom-docker.js";
import { HeadroomEdgeClient, normalizeCompressionUrl, type EdgeCompressionStatus } from "./headroom-edge-client.js";
import {
  HEADROOM_CONTAINER_NAME,
  HEADROOM_PORT,
  HEADROOM_VOLUME_NAME,
  headroomSettings,
  publicHeadroomSettings,
  type HeadroomPublicSettings,
  type HeadroomSettings,
} from "./headroom-plugin.js";

export type HeadroomModuleState = {
  enabled: boolean;
  settings: Record<string, unknown>;
};

export type HeadroomModuleStateSource = () => HeadroomModuleState | null;

export type HeadroomOperationPhase =
  | "idle"
  | "pulling"
  | "creating"
  | "starting"
  | "stopping"
  | "ready"
  | "error";

export type HeadroomOperation = {
  phase: HeadroomOperationPhase;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

export type HeadroomProvisionState = {
  version: 1;
  /** Managed sidecar token and endpoint. */
  token?: string;
  url?: string;
  image?: string;
  /** Token for an external Headroom service (manual mode). */
  manualToken?: string;
  updatedAt: string;
};

export type HeadroomProbe = {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error?: string;
};

export type HeadroomStatus = {
  installed: boolean;
  settings: HeadroomPublicSettings;
  docker: { available: boolean; socket: string | null; version?: string; error?: string };
  container: {
    name: string;
    exists: boolean;
    running: boolean;
    id?: string;
    image?: string;
    status?: string;
    health?: string;
  };
  service: {
    url: string | null;
    origin: "managed" | "manual" | null;
    healthy: boolean;
    status: number | null;
    latencyMs: number;
    error?: string;
  };
  edge: {
    available: boolean;
    enabled: boolean;
    url: string | null;
    mode: string | null;
    error?: string;
  };
  operation: HeadroomOperation;
};

export type HeadroomProvisionerOptions = {
  /** Where the generated proxy token and resolved URL are persisted (0600). */
  statePath: string;
  edge: HeadroomEdgeClient;
  moduleState: HeadroomModuleStateSource;
  /** Injected engine for tests; `null` disables container management. */
  docker?: DockerEngine | null;
  dockerSocket?: string | null;
  containerName?: string;
  volumeName?: string;
  /** Overrides network discovery; otherwise the MultiVibe container's network is reused. */
  network?: string;
  runningInContainer?: boolean;
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
  now?: () => Date;
};

const READY_TIMEOUT_MS = 90_000;
const READY_INTERVAL_MS = 1_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOurContainer(container: DockerContainer | null): boolean {
  return container?.Config?.Labels?.["multivibe.extension"] === "headroom";
}

export class HeadroomProvisioner {
  private readonly env: NodeJS.ProcessEnv;
  private readonly request: typeof fetch;
  private readonly containerName: string;
  private readonly volumeName: string;
  private readonly dockerProvided: boolean;
  private resolvedDocker: DockerEngine | null | undefined;
  private operation: HeadroomOperation = { phase: "idle" };
  private pending: Promise<void> | null = null;

  constructor(private readonly options: HeadroomProvisionerOptions) {
    this.env = options.env ?? process.env;
    this.request = options.request ?? fetch;
    this.containerName = options.containerName ?? HEADROOM_CONTAINER_NAME;
    this.volumeName = options.volumeName ?? HEADROOM_VOLUME_NAME;
    this.dockerProvided = "docker" in options;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private get runningInContainer(): boolean {
    if (this.options.runningInContainer !== undefined) return this.options.runningInContainer;
    return fs.existsSync("/.dockerenv");
  }

  private docker(): DockerEngine | null {
    if (this.dockerProvided) return this.options.docker ?? null;
    if (this.resolvedDocker !== undefined) return this.resolvedDocker;
    const socket =
      this.options.dockerSocket === undefined
        ? resolveDockerSocket(this.env)
        : this.options.dockerSocket;
    this.resolvedDocker = socket ? DockerEngine.fromSocket(socket) : null;
    return this.resolvedDocker;
  }

  private requireDocker(): DockerEngine {
    const docker = this.docker();
    if (!docker) {
      throw new Error(
        "The Docker daemon is not reachable. Mount /var/run/docker.sock into the MultiVibe container, or turn off container management and point at an existing Headroom service.",
      );
    }
    return docker;
  }

  private settings(): HeadroomSettings {
    return headroomSettings(this.options.moduleState()?.settings);
  }

  private setOperation(phase: HeadroomOperationPhase, message?: string, error?: string): void {
    this.operation =
      phase === "pulling" || phase === "creating" || phase === "starting" || phase === "stopping"
        ? { phase, startedAt: this.nowIso(), message }
        : { phase, message, error, startedAt: this.operation.startedAt, finishedAt: this.nowIso() };
  }

  async loadState(): Promise<HeadroomProvisionState | null> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.options.statePath, "utf8"));
      if (typeof parsed?.version !== "number" || parsed.version !== 1) return null;
      if (typeof parsed.updatedAt !== "string") return null;
      const optional = (value: unknown) => value === undefined || typeof value === "string";
      if (
        !optional(parsed.token) ||
        !optional(parsed.url) ||
        !optional(parsed.image) ||
        !optional(parsed.manualToken)
      ) {
        return null;
      }
      return parsed as HeadroomProvisionState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      console.warn(`[headroom] unreadable provision state: ${errorMessage(error)}`);
      return null;
    }
  }

  private async saveState(state: HeadroomProvisionState): Promise<void> {
    await fsp.mkdir(path.dirname(this.options.statePath), { recursive: true });
    const temporary = `${this.options.statePath}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(temporary, this.options.statePath);
  }

  private async clearState(): Promise<void> {
    await fsp.rm(this.options.statePath, { force: true });
  }

  private async probe(url: string, token?: string): Promise<HeadroomProbe> {
    const base = url.replace(/\/v1\/compress\/?$/u, "");
    const started = Date.now();
    try {
      const response = await this.request(`${base}/readyz`, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(3_000),
        headers: {
          accept: "application/json",
          ...(token ? { "x-headroom-proxy-token": token } : {}),
        },
      });
      return { ok: response.ok, status: response.status, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        status: null,
        latencyMs: Date.now() - started,
        error: errorMessage(error),
      };
    }
  }

  async test(url?: string): Promise<HeadroomProbe> {
    if (url?.trim()) {
      const normalized = normalizeCompressionUrl(url);
      if (!normalized) throw new Error("The Headroom URL must be an http(s) URL without credentials");
      const state = await this.loadState();
      return this.probe(normalized, this.settings().manageContainer ? state?.token : state?.manualToken);
    }
    const target = await this.serviceTarget();
    if (!target) throw new Error("Headroom is not configured yet");
    return this.probe(target.url, target.token);
  }

  private async serviceTarget(): Promise<{ url: string; token?: string; origin: "managed" | "manual" } | null> {
    const settings = this.settings();
    const state = await this.loadState();
    if (settings.manageContainer) {
      return state?.url ? { url: state.url, token: state.token, origin: "managed" } : null;
    }
    if (!settings.serverUrl) return null;
    const url = normalizeCompressionUrl(settings.serverUrl);
    return url ? { url, token: state?.manualToken, origin: "manual" } : null;
  }

  private async dockerStatus(): Promise<HeadroomStatus["docker"]> {
    const docker = this.docker();
    const socket = this.options.dockerSocket === undefined
      ? resolveDockerSocket(this.env)
      : this.options.dockerSocket;
    if (!docker) {
      return { available: false, socket: socket ?? null, error: "Docker socket not found" };
    }
    try {
      return { available: true, socket: socket ?? null, version: await docker.ping() };
    } catch (error) {
      return { available: false, socket: socket ?? null, error: errorMessage(error) };
    }
  }

  private async containerStatus(docker: DockerEngine | null): Promise<HeadroomStatus["container"]> {
    if (!docker) return { name: this.containerName, exists: false, running: false };
    try {
      if (!docker) return { name: this.containerName, exists: false, running: false };
      const container = await docker.inspect(this.containerName);
      if (!container) return { name: this.containerName, exists: false, running: false };
      return {
        name: this.containerName,
        exists: true,
        running: Boolean(container.State?.Running),
        id: container.Id,
        image: container.Config?.Image,
        status: container.State?.Status,
        health: container.State?.Health?.Status,
      };
    } catch (error) {
      return {
        name: this.containerName,
        exists: false,
        running: false,
        status: errorMessage(error),
      };
    }
  }

  private async edgeStatus(): Promise<HeadroomStatus["edge"]> {
    try {
      const status = await this.options.edge.status();
      return {
        available: true,
        enabled: Boolean(status.enabled),
        url: status.url ?? null,
        mode: status.mode ?? null,
      };
    } catch (error) {
      return { available: false, enabled: false, url: null, mode: null, error: errorMessage(error) };
    }
  }

  private async applyNow(manualToken?: string): Promise<void> {
    const module = this.options.moduleState();
    const settings = this.settings();
    const state = await this.loadState();
    if (manualToken) {
      // The manual token never enters the module settings: it lives beside the
      // managed token in the 0600 state file and is only pushed to the edge.
      await this.saveState({
        ...(state ?? { version: 1 as const }),
        version: 1,
        manualToken,
        updatedAt: this.nowIso(),
      });
    }
    if (!module?.enabled) {
      await this.options.edge.clear();
      return;
    }
    if (settings.manageContainer) {
      if (!state?.url) throw new Error("Headroom is not installed yet");
      await this.pushEdge(settings, { url: state.url, token: state.token });
      return;
    }
    if (!settings.serverUrl) {
      await this.options.edge.clear();
      return;
    }
    const url = normalizeCompressionUrl(settings.serverUrl);
    if (!url) throw new Error("The manual Headroom URL must be an http(s) URL without credentials");
    await this.pushEdge(settings, { url, token: manualToken || state?.manualToken });
  }

  private async pushEdge(
    settings: HeadroomSettings,
    target: { url: string; token?: string },
  ): Promise<void> {
    await this.options.edge.apply({
      url: target.url,
      token: target.token,
      mode: settings.mode,
      timeoutMs: settings.timeoutMs,
      minBytes: settings.minBytes,
    });
  }

  /** Store an external service token and reapply the contract. */
  async apply(manualToken?: string): Promise<HeadroomStatus> {
    await this.applyNow(manualToken);
    return this.status();
  }

  async status(): Promise<HeadroomStatus> {
    const settings = this.settings();
    const docker = this.docker();
    const [dockerStatus, state, edge] = await Promise.all([
      this.dockerStatus(),
      this.loadState(),
      this.edgeStatus(),
    ]);
    const container = await this.containerStatus(dockerStatus.available ? docker : null);
    const target = await this.serviceTarget();
    // The proxy token lives in the state file, never in the module settings, so
    // the public view only reports whether one is stored.
    const publicSettings = publicHeadroomSettings(settings, Boolean(target?.token));
    let service: HeadroomStatus["service"] = {
      url: target?.url ?? null,
      origin: target?.origin ?? null,
      healthy: false,
      status: null,
      latencyMs: 0,
    };
    if (target) {
      const probe = await this.probe(target.url, target.token);
      service = {
        url: target.url,
        origin: target.origin,
        healthy: probe.ok,
        status: probe.status,
        latencyMs: probe.latencyMs,
        error: probe.error,
      };
    }
    return {
      installed: Boolean(state?.url && container.exists),
      settings: publicSettings,
      docker: dockerStatus,
      container,
      service,
      edge,
      operation: this.operation,
    };
  }

  async install(): Promise<HeadroomStatus> {
    if (!this.pending) {
      this.pending = this.runInstall().finally(() => {
        this.pending = null;
      });
      void this.pending.catch(() => undefined);
    }
    return this.status();
  }

  /** Resolves once an in-flight install settles; used by tests and callers that must wait. */
  async settled(): Promise<void> {
    await this.pending?.catch(() => undefined);
  }

  private containerConfig(settings: HeadroomSettings, token: string, network: string): Record<string, unknown> {
    const hostConfig: Record<string, unknown> = {
      NetworkMode: network,
      RestartPolicy: { Name: "unless-stopped" },
      // The image runs as root with its state volume at /root/.headroom.
      Binds: [`${this.volumeName}:/root/.headroom`],
    };
    const env = [
      "HEADROOM_HOST=0.0.0.0",
      `HEADROOM_PORT=${HEADROOM_PORT}`,
      `HEADROOM_PROXY_TOKEN=${token}`,
      "HOME=/root",
    ];
    if (this.runningInContainer) {
      // Headroom's /v1/compress loopback guard rejects peer containers on the
      // bridge network with a 404 by default. The sidecar is only reachable on
      // MultiVibe's network and still requires the proxy token, so opt this
      // route out of the loopback dependency. A host install keeps the default
      // because it reaches the sidecar over a published loopback port.
      env.push("HEADROOM_COMPRESS_ALLOW_REMOTE=1");
    } else {
      hostConfig.PortBindings = { [`${HEADROOM_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }] };
    }
    return {
      Image: settings.image,
      Env: env,
      Labels: { "multivibe.extension": "headroom", "multivibe.managed": "true" },
      ExposedPorts: { [`${HEADROOM_PORT}/tcp`]: {} },
      HostConfig: hostConfig,
    };
  }

  private async resolveNetwork(docker: DockerEngine): Promise<string> {
    if (this.options.network) return this.options.network;
    // Outside a container the published loopback port is the transport, so any
    // network works and the default bridge is the least surprising choice.
    if (!this.runningInContainer) return "bridge";
    const self = this.env.HOSTNAME;
    if (self) {
      try {
        const info = await docker.inspect(self);
        const name = Object.keys(info?.NetworkSettings?.Networks ?? {})[0];
        if (name) return name;
      } catch {
        // Fall through to the explicit error.
      }
    }
    throw new Error(
      "Could not determine which Docker network MultiVibe runs on; set MULTIVIBE_EXTENSION_NETWORK",
    );
  }

  private async serviceUrl(docker: DockerEngine, id: string): Promise<string> {
    if (this.runningInContainer) {
      return `http://${this.containerName}:${HEADROOM_PORT}/v1/compress`;
    }
    const info = await docker.inspect(id);
    const binding = info?.NetworkSettings?.Ports?.[`${HEADROOM_PORT}/tcp`]?.[0];
    if (!binding?.HostPort) {
      throw new Error("Docker did not publish the Headroom port");
    }
    return `http://127.0.0.1:${binding.HostPort}/v1/compress`;
  }

  private async waitHealthy(url: string, token: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last: HeadroomProbe | null = null;
    while (Date.now() < deadline) {
      last = await this.probe(url, token);
      if (last.ok) return;
      await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
    }
    throw new Error(
      `Headroom did not become ready within ${READY_TIMEOUT_MS / 1_000}s${last?.error ? `: ${last.error}` : ""}`,
    );
  }

  private async runInstall(): Promise<void> {
    try {
      const settings = this.settings();
      // Set the phase before the first await so a panel that reloads right
      // after enabling the extension starts polling immediately.
      this.setOperation("pulling", settings.image);
      const docker = this.requireDocker();
      await docker.ping();
      await docker.pull(settings.image);

      this.setOperation("creating", this.containerName);
      const network = await this.resolveNetwork(docker);
      const previous = await this.loadState();
      const token = previous?.token ?? crypto.randomBytes(32).toString("hex");

      let container = await docker.inspect(this.containerName);
      if (container && !isOurContainer(container)) {
        throw new Error(
          `A container named ${this.containerName} already exists and is not managed by MultiVibe`,
        );
      }
      if (container && container.Config?.Image !== settings.image) {
        if (container.State?.Running) await docker.stop(container.Id);
        await docker.remove(container.Id);
        container = null;
      }
      if (!container) {
        const created = await docker.create(this.containerName, this.containerConfig(settings, token, network));
        container = await docker.inspect(created.Id);
        if (!container) throw new Error("Docker did not return the created container");
      }

      this.setOperation("starting", this.containerName);
      if (!container.State?.Running) await docker.start(container.Id);
      const url = await this.serviceUrl(docker, container.Id);
      await this.waitHealthy(url, token);
      await this.saveState({
        version: 1,
        token,
        url,
        image: settings.image,
        updatedAt: this.nowIso(),
      });
      await this.applyNow();
      this.setOperation("ready", "Headroom is running and compression is active");
    } catch (error) {
      this.setOperation("error", undefined, errorMessage(error));
      throw error;
    }
  }

  async start(): Promise<HeadroomStatus> {
    const docker = this.requireDocker();
    const settings = this.settings();
    const container = await docker.inspect(this.containerName);
    if (!container) return this.install();
    const state = await this.loadState();
    if (!state?.token) return this.install();
    this.setOperation("starting", this.containerName);
    try {
      if (!container.State?.Running) await docker.start(container.Id);
      const url = await this.serviceUrl(docker, container.Id);
      await this.waitHealthy(url, state.token);
      await this.saveState({ ...state, url, image: settings.image, updatedAt: this.nowIso() });
      await this.applyNow();
      this.setOperation("ready", "Headroom is running and compression is active");
    } catch (error) {
      this.setOperation("error", undefined, errorMessage(error));
      throw error;
    }
    return this.status();
  }

  async stop(): Promise<HeadroomStatus> {
    this.setOperation("stopping", "Stopping Headroom");
    try {
      const docker = this.docker();
      if (docker) {
        const container = await docker.inspect(this.containerName);
        if (container?.State?.Running) await docker.stop(container.Id);
      }
      await this.options.edge.clear();
      this.setOperation("idle", "Headroom is stopped and compression is disabled");
    } catch (error) {
      this.setOperation("error", undefined, errorMessage(error));
      throw error;
    }
    return this.status();
  }

  async uninstall(): Promise<HeadroomStatus> {
    this.setOperation("starting", "Removing Headroom");
    try {
      const docker = this.docker();
      if (docker) {
        const container = await docker.inspect(this.containerName);
        if (container) {
          if (container.State?.Running) await docker.stop(container.Id);
          await docker.remove(container.Id);
        }
        await docker.removeVolume(this.volumeName);
      }
      await this.clearState();
      await this.options.edge.clear();
      this.setOperation("idle", "Headroom was removed");
    } catch (error) {
      this.setOperation("error", undefined, errorMessage(error));
      throw error;
    }
    return this.status();
  }

  /**
   * Best-effort startup reconciliation: the extension state is the source of
   * truth, the edge is configured from it, and a missing managed container is
   * reinstalled in the background.
   */
  async reconcile(): Promise<void> {
    const module = this.options.moduleState();
    if (!module) return;
    const saved = await this.loadState();
    if (!module.enabled) {
      // Nothing was ever provisioned by this installation: do not touch Docker
      // or the edge on every startup of an unrelated deployment.
      if (!saved) return;
      try {
        const docker = this.docker();
        if (docker) {
          const container = await docker.inspect(this.containerName);
          if (container?.State?.Running) await docker.stop(container.Id);
        }
        await this.options.edge.clear();
      } catch (error) {
        console.warn(`[headroom] could not disable compression: ${errorMessage(error)}`);
      }
      return;
    }
    try {
      if (this.settings().manageContainer) {
        const docker = this.docker();
        const container = docker ? await docker.inspect(this.containerName) : null;
        if (!saved?.token || !container) {
          await this.install();
          return;
        }
        if (!container.State?.Running) {
          await docker!.start(container.Id);
        }
        const url = await this.serviceUrl(docker!, container.Id);
        await this.waitHealthy(url, saved.token);
        await this.saveState({ ...saved, url, image: this.settings().image, updatedAt: this.nowIso() });
        await this.pushEdge(this.settings(), { url, token: saved.token });
      } else {
        await this.applyNow();
      }
    } catch (error) {
      console.warn(`[headroom] startup reconciliation failed: ${errorMessage(error)}`);
    }
  }

  /** Called after the module is enabled/disabled so the container follows the switch. */
  async syncEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      try {
        const docker = this.docker();
        if (docker) {
          const container = await docker.inspect(this.containerName);
          if (container?.State?.Running) await docker.stop(container.Id);
        }
        await this.options.edge.clear();
      } catch (error) {
        console.warn(`[headroom] could not stop with the extension: ${errorMessage(error)}`);
      }
      return;
    }
    try {
      await this.reconcile();
    } catch (error) {
      console.warn(`[headroom] could not start with the extension: ${errorMessage(error)}`);
    }
  }
}
