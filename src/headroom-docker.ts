import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * Minimal Docker Engine API client.
 *
 * MultiVibe talks to the daemon over its Unix socket with plain HTTP instead of
 * shelling out to the `docker` CLI: the runtime image does not need a CLI, and
 * arguments never pass through a shell.  The transport is injectable so the
 * provisioner can be tested without a daemon.
 */
export type DockerRequest = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs?: number;
};

export type DockerResponse = {
  status: number;
  body: string;
};

export type DockerTransport = (request: DockerRequest) => Promise<DockerResponse>;

export type DockerContainer = {
  Id: string;
  Name?: string;
  Config?: {
    Image?: string;
    Labels?: Record<string, string> | null;
    Env?: string[] | null;
  };
  State?: {
    Status?: string;
    Running?: boolean;
    Health?: { Status?: string } | null;
  };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null;
    Networks?: Record<string, unknown> | null;
  };
};

export function dockerSocketCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string[] {
  const candidates: string[] = [];
  const explicit = env.MULTIVIBE_DOCKER_SOCKET?.trim();
  if (explicit) candidates.push(explicit);
  const host = env.DOCKER_HOST?.trim();
  if (host?.startsWith("unix://")) candidates.push(host.slice("unix://".length));
  candidates.push(
    "/var/run/docker.sock",
    path.join(home, ".docker/run/docker.sock"),
    path.join(home, ".docker/desktop/docker.sock"),
    path.join(home, ".orbstack/run/docker.sock"),
  );
  if (process.platform === "win32") {
    // Docker Desktop's named pipe; Node accepts it as a socketPath.
    candidates.push("//./pipe/docker_engine");
  }
  if (typeof process.getuid === "function") {
    candidates.push(`/run/user/${process.getuid()}/docker.sock`);
  }
  return [...new Set(candidates)];
}

export function resolveDockerSocket(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string | null {
  for (const candidate of dockerSocketCandidates(env, home)) {
    try {
      if (fs.statSync(candidate).isSocket()) return candidate;
    } catch {
      // The socket is absent; try the next candidate.
    }
  }
  return null;
}

export function unixDockerTransport(socketPath: string): DockerTransport {
  return ({ method, path: requestPath, body, timeoutMs = 20_000 }) =>
    new Promise<DockerResponse>((resolve, reject) => {
      const request = http.request(
        {
          socketPath,
          path: requestPath,
          method,
          headers: body === undefined
            ? { accept: "application/json" }
            : { accept: "application/json", "content-type": "application/json" },
          timeout: timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          response.on("error", reject);
        },
      );
      request.on("timeout", () =>
        request.destroy(new Error(`docker request timed out after ${timeoutMs}ms`)),
      );
      request.on("error", reject);
      if (body !== undefined) request.write(JSON.stringify(body));
      request.end();
    });
}

function dockerErrorMessage(response: DockerResponse): string {
  try {
    const parsed = JSON.parse(response.body);
    if (typeof parsed?.message === "string" && parsed.message.trim()) return parsed.message;
  } catch {
    // Fall through to the raw body.
  }
  return response.body.trim() || `docker responded with ${response.status}`;
}

export function splitImageTag(image: string): { repository: string; tag: string } {
  const withoutDigest = image.split("@")[0];
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash
    ? { repository: withoutDigest.slice(0, colon), tag: withoutDigest.slice(colon + 1) }
    : { repository: withoutDigest, tag: "latest" };
}

export class DockerEngine {
  private apiVersion: string | null = null;

  constructor(private readonly transport: DockerTransport) {}

  static fromSocket(socketPath: string): DockerEngine {
    return new DockerEngine(unixDockerTransport(socketPath));
  }

  /** Returns the daemon version; throws when the socket is unreachable. */
  async ping(): Promise<string> {
    const response = await this.transport({ method: "GET", path: "/version", timeoutMs: 5_000 });
    if (response.status >= 400) throw new Error(dockerErrorMessage(response));
    const parsed = JSON.parse(response.body) as { Version?: string; ApiVersion?: string };
    if (!parsed.ApiVersion) throw new Error("docker did not report an API version");
    this.apiVersion = parsed.ApiVersion;
    return parsed.Version ?? parsed.ApiVersion;
  }

  private async versioned(pathname: string): Promise<string> {
    if (!this.apiVersion) await this.ping();
    return `/v${this.apiVersion}${pathname}`;
  }

  private async json<T>(
    method: DockerRequest["method"],
    pathname: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const response = await this.transport({
      method,
      path: await this.versioned(pathname),
      body,
      timeoutMs,
    });
    if (response.status >= 400) throw new Error(dockerErrorMessage(response));
    return (response.body ? JSON.parse(response.body) : null) as T;
  }

  async inspect(container: string): Promise<DockerContainer | null> {
    const response = await this.transport({
      method: "GET",
      path: await this.versioned(`/containers/${encodeURIComponent(container)}/json`),
    });
    if (response.status === 404) return null;
    if (response.status >= 400) throw new Error(dockerErrorMessage(response));
    return JSON.parse(response.body) as DockerContainer;
  }

  async pull(image: string): Promise<void> {
    const { repository, tag } = splitImageTag(image);
    const query = new URLSearchParams({ fromImage: repository, tag });
    const response = await this.transport({
      method: "POST",
      path: await this.versioned(`/images/create?${query.toString()}`),
      // Pulling a cold image is the slowest step of an install.
      timeoutMs: 15 * 60_000,
    });
    if (response.status >= 400) throw new Error(dockerErrorMessage(response));
    for (const line of response.body.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { error?: string; errorDetail?: { message?: string } };
        const error = event.errorDetail?.message ?? event.error;
        if (error) throw new Error(error);
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
  }

  async create(
    name: string,
    config: Record<string, unknown>,
  ): Promise<{ Id: string }> {
    const query = new URLSearchParams({ name });
    return this.json("POST", `/containers/create?${query.toString()}`, config, 60_000);
  }

  async start(id: string): Promise<void> {
    await this.json("POST", `/containers/${encodeURIComponent(id)}/start`, undefined, 60_000);
  }

  async stop(id: string, timeoutSeconds = 10): Promise<void> {
    const response = await this.transport({
      method: "POST",
      path: await this.versioned(
        `/containers/${encodeURIComponent(id)}/stop?t=${timeoutSeconds}`,
      ),
      timeoutMs: (timeoutSeconds + 30) * 1_000,
    });
    // 304 means the container was already stopped.
    if (response.status >= 400 && response.status !== 304) {
      throw new Error(dockerErrorMessage(response));
    }
  }

  async remove(id: string): Promise<void> {
    const response = await this.transport({
      method: "DELETE",
      path: await this.versioned(`/containers/${encodeURIComponent(id)}?force=1&v=1`),
      timeoutMs: 60_000,
    });
    if (response.status >= 400 && response.status !== 404) {
      throw new Error(dockerErrorMessage(response));
    }
  }

  async removeVolume(name: string): Promise<void> {
    const response = await this.transport({
      method: "DELETE",
      path: await this.versioned(`/volumes/${encodeURIComponent(name)}?force=1`),
      timeoutMs: 30_000,
    });
    if (response.status >= 400 && response.status !== 404) {
      throw new Error(dockerErrorMessage(response));
    }
  }
}
