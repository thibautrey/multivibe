import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HeadroomEdgeClient, type EdgeCompressionStatus } from "./headroom-edge-client.js";
import { DockerEngine, type DockerRequest, type DockerResponse, type DockerTransport } from "./headroom-docker.js";
import { HeadroomProvisioner } from "./headroom-provisioner.js";
import {
  HEADROOM_CONTAINER_NAME,
  HEADROOM_DEFAULT_SETTINGS,
  HEADROOM_VOLUME_NAME,
  type HeadroomSettings,
} from "./headroom-plugin.js";

type FakeContainer = {
  Id: string;
  Name: string;
  Config: { Image?: string; Labels?: Record<string, string>; Env?: string[] };
  State: { Status?: string; Running?: boolean; Health?: { Status?: string } };
  NetworkSettings: {
    Ports: Record<string, Array<{ HostIp?: string; HostPort?: string }>>;
    Networks: Record<string, unknown>;
  };
};

/** Stateful stand-in for the Docker daemon, fed through the real engine client. */
class FakeDocker {
  readonly containers = new Map<string, FakeContainer>();
  readonly volumes = new Set<string>();
  readonly requests: DockerRequest[] = [];
  failPull: string | null = null;
  private sequence = 0;

  transport: DockerTransport = async (request) => {
    this.requests.push(request);
    const [rawPath, rawQuery = ""] = request.path.split("?");
    const pathname = rawPath.replace(/^\/v[0-9][^/]*/u, "");
    const query = new URLSearchParams(rawQuery);
    const json = (body: unknown, status = 200): DockerResponse => ({
      status,
      body: JSON.stringify(body),
    });

    if (pathname === "/version") {
      return json({ Version: "27.3.1", ApiVersion: "1.46" });
    }
    if (pathname === "/images/create") {
      const image = query.get("fromImage");
      const tag = query.get("tag");
      if (this.failPull) {
        return { status: 200, body: `${JSON.stringify({ errorDetail: { message: this.failPull } })}\n` };
      }
      return { status: 200, body: `${JSON.stringify({ status: "Downloaded newer image", image, tag })}\n` };
    }
    if (pathname === "/containers/create" && request.method === "POST") {
      const name = query.get("name");
      assert.ok(name, "docker create needs a name");
      const body = request.body as {
        Image?: string;
        Labels?: Record<string, string>;
        Env?: string[];
        HostConfig?: { Binds?: string[]; NetworkMode?: string; PortBindings?: Record<string, Array<{ HostPort?: string }>> };
      };
      for (const bind of body.HostConfig?.Binds ?? []) {
        const [source] = bind.split(":");
        if (source && !source.includes("/")) this.volumes.add(source);
      }
      const published = body.HostConfig?.PortBindings?.["8787/tcp"]?.length
        ? [{ HostIp: "127.0.0.1", HostPort: "32768" }]
        : null;
      const record: FakeContainer = {
        Id: `ctr-${++this.sequence}`,
        Name: `/${name}`,
        Config: { Image: body.Image, Labels: body.Labels ?? {}, Env: body.Env ?? [] },
        State: { Status: "created", Running: false },
        NetworkSettings: {
          Ports: published ? { "8787/tcp": published } : {},
          Networks: { [body.HostConfig?.NetworkMode ?? "bridge"]: {} },
        },
      };
      this.containers.set(name, record);
      return json({ Id: record.Id, Warnings: [] }, 201);
    }
    const containerMatch = pathname.match(/^\/containers\/(.+?)(\/json|\/start|\/stop)?$/u);
    if (containerMatch) {
      const [, key, action] = containerMatch;
      const record = this.containers.get(key)
        ?? Array.from(this.containers.values()).find((entry) => entry.Id === key);
      if (!record) return json({ message: `No such container: ${key}` }, 404);
      if (!action && request.method === "DELETE") {
        this.containers.delete(record.Name.replace(/^\//u, ""));
        return { status: 204, body: "" };
      }
      if (action === "/json") return json(record);
      if (action === "/start") {
        record.State = { Status: "running", Running: true, Health: { Status: "healthy" } };
        return { status: 204, body: "" };
      }
      if (action === "/stop") {
        record.State = { Status: "exited", Running: false };
        return { status: 204, body: "" };
      }
    }
    if (pathname.startsWith("/volumes/")) {
      this.volumes.delete(decodeURIComponent(pathname.slice("/volumes/".length)));
      return { status: 204, body: "" };
    }
    return json({ message: `unhandled ${request.method} ${pathname}` }, 500);
  };

  /** Seed a container as if a previous deployment left it behind. */
  seed(name: string, image: string, options: { running?: boolean; labels?: Record<string, string> } = {}) {
    const record: FakeContainer = {
      Id: `seed-${++this.sequence}`,
      Name: `/${name}`,
      Config: {
        Image: image,
        Labels: options.labels ?? { "multivibe.extension": "headroom", "multivibe.managed": "true" },
        Env: [],
      },
      State: { Status: options.running ? "running" : "exited", Running: Boolean(options.running) },
      NetworkSettings: { Ports: {}, Networks: { multivibe_default: {} } },
    };
    this.containers.set(name, record);
    return record;
  }
}

function fakeEdge() {
  let state: EdgeCompressionStatus = {
    enabled: false,
    url: null,
    mode: null,
    timeoutMs: HEADROOM_DEFAULT_SETTINGS.timeoutMs,
    minBytes: HEADROOM_DEFAULT_SETTINGS.minBytes,
    configError: null,
  };
  const calls: Array<{ method: string; headers: Record<string, string>; body: Record<string, unknown> | null }> = [];
  const request = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const method = init?.method ?? "GET";
    calls.push({ method, headers, body });
    if (method === "PUT") {
      state = {
        enabled: true,
        url: String(body.url),
        mode: body.mode ? String(body.mode) : null,
        timeoutMs: Number(body.timeoutMs),
        minBytes: Number(body.minBytes),
        configError: null,
      };
    } else if (method === "DELETE") {
      state = { ...state, enabled: false, url: null, mode: null };
    }
    return new Response(JSON.stringify(state), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    client: new HeadroomEdgeClient({ baseUrl: "http://edge.test", token: "internal-secret", request }),
    calls,
    state: () => state,
  };
}

const probeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith("/readyz")) return new Response("{}", { status: 200 });
  throw new Error(`unexpected probe ${url}`);
}) as typeof fetch;

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-headroom-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function setup(
  root: string,
  options: {
    enabled?: boolean;
    settings?: Partial<HeadroomSettings>;
    docker?: FakeDocker | null;
    runningInContainer?: boolean;
    /** `null` leaves network discovery to the provisioner. */
    network?: string | null;
  } = {},
) {
  const fake = options.docker === undefined ? new FakeDocker() : options.docker;
  const edge = fakeEdge();
  let moduleState = {
    enabled: options.enabled ?? true,
    settings: { ...HEADROOM_DEFAULT_SETTINGS, ...options.settings } as unknown as Record<string, unknown>,
  };
  const provisioner = new HeadroomProvisioner({
    statePath: path.join(root, "headroom-provision.json"),
    edge: edge.client,
    moduleState: () => moduleState,
    docker: fake ? new DockerEngine(fake.transport) : null,
    dockerSocket: "/var/run/docker.sock",
    runningInContainer: options.runningInContainer ?? true,
    network: options.network === null ? undefined : options.network ?? "multivibe_default",
    env: { ...process.env, MULTIVIBE_DOCKER_SOCKET: "/var/run/docker.sock" },
    request: probeFetch,
    now: () => new Date("2026-02-03T04:05:06.000Z"),
  });
  return {
    provisioner,
    docker: fake as FakeDocker,
    edge,
    setEnabled: (enabled: boolean) => {
      moduleState = { ...moduleState, enabled };
    },
  };
}

const statePath = (root: string) => path.join(root, "headroom-provision.json");

test("install provisions a managed sidecar and activates compression", async () => {
  await withRoot(async (root) => {
    const harness = setup(root);
    await harness.provisioner.install();
    await harness.provisioner.settled();

    const status = await harness.provisioner.status();
    assert.equal(status.operation.phase, "ready");
    assert.equal(status.installed, true);
    assert.equal(status.container.exists, true);
    assert.equal(status.container.running, true);
    assert.equal(status.service.healthy, true);
    assert.equal(status.service.url, `http://${HEADROOM_CONTAINER_NAME}:8787/v1/compress`);
    assert.equal(status.settings.hasProxyToken, true);
    assert.equal((status.settings as unknown as Record<string, unknown>).proxyToken, undefined);

    const container = harness.docker.containers.get(HEADROOM_CONTAINER_NAME);
    assert.ok(container);
    assert.equal(container.Config.Image, HEADROOM_DEFAULT_SETTINGS.image);
    assert.deepEqual(container.Config.Labels, {
      "multivibe.extension": "headroom",
      "multivibe.managed": "true",
    });
    assert.deepEqual(Object.keys(container.NetworkSettings.Networks), ["multivibe_default"]);
    assert.equal(container.NetworkSettings.Ports["8787/tcp"], undefined, "no host port inside a container");
    assert.ok(container.Config.Env?.includes("HOME=/root"));
    const create = harness.docker.requests.find((request) =>
      request.path.includes("/containers/create"),
    );
    assert.deepEqual(
      (create?.body as { HostConfig?: { Binds?: string[] } }).HostConfig?.Binds,
      [`${HEADROOM_VOLUME_NAME}:/root/.headroom`],
    );

    const saved = JSON.parse(await fs.readFile(statePath(root), "utf8"));
    assert.match(saved.token, /^[0-9a-f]{64}$/u);
    assert.equal(saved.url, `http://${HEADROOM_CONTAINER_NAME}:8787/v1/compress`);
    assert.equal(saved.image, HEADROOM_DEFAULT_SETTINGS.image);
    assert.equal(saved.updatedAt, "2026-02-03T04:05:06.000Z");
    assert.equal((await fs.stat(statePath(root))).mode & 0o777, 0o600);
    assert.ok(container.Config.Env?.includes(`HEADROOM_PROXY_TOKEN=${saved.token}`));

    const pushed = harness.edge.calls.filter((call) => call.method === "PUT").at(-1);
    assert.ok(pushed);
    assert.deepEqual(pushed.body, {
      url: saved.url,
      token: saved.token,
      mode: null,
      timeoutMs: HEADROOM_DEFAULT_SETTINGS.timeoutMs,
      minBytes: HEADROOM_DEFAULT_SETTINGS.minBytes,
    });
    assert.equal(pushed.headers["x-multivibe-internal-token"], "internal-secret");
    assert.equal(harness.edge.state().enabled, true);

    // The generated token never leaves the server through the status payload.
    assert.equal(JSON.stringify(status).includes(saved.token), false);
  });
});

test("a second install is idempotent and keeps one running container", async () => {
  await withRoot(async (root) => {
    const harness = setup(root);
    await harness.provisioner.install();
    await harness.provisioner.settled();
    const firstToken = JSON.parse(await fs.readFile(statePath(root), "utf8")).token;

    await harness.provisioner.install();
    await harness.provisioner.settled();

    const creates = harness.docker.requests.filter((request) => request.path.includes("/containers/create"));
    assert.equal(creates.length, 1);
    const saved = JSON.parse(await fs.readFile(statePath(root), "utf8"));
    assert.equal(saved.token, firstToken);
    assert.equal(harness.docker.containers.size, 1);
  });
});

test("a changed image replaces the managed container and keeps the token", async () => {
  await withRoot(async (root) => {
    const harness = setup(root);
    harness.docker.seed(HEADROOM_CONTAINER_NAME, "ghcr.io/headroomlabs-ai/headroom:0.44.0", {
      running: true,
    });
    await fs.writeFile(
      statePath(root),
      JSON.stringify({
        version: 1,
        token: "kept-token",
        url: "http://old/v1/compress",
        image: "ghcr.io/headroomlabs-ai/headroom:0.44.0",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await harness.provisioner.install();
    await harness.provisioner.settled();

    const status = await harness.provisioner.status();
    assert.equal(status.operation.phase, "ready");
    const container = harness.docker.containers.get(HEADROOM_CONTAINER_NAME);
    assert.ok(container);
    assert.equal(container.Config.Image, HEADROOM_DEFAULT_SETTINGS.image);
    assert.ok(container.Config.Env?.includes("HEADROOM_PROXY_TOKEN=kept-token"));
    assert.equal(harness.docker.requests.some((request) => request.path.includes("/stop")), true);
    assert.equal(JSON.parse(await fs.readFile(statePath(root), "utf8")).token, "kept-token");
  });
});

test("a foreign container with the same name is never adopted", async () => {
  await withRoot(async (root) => {
    const harness = setup(root);
    harness.docker.seed(HEADROOM_CONTAINER_NAME, "somebody/else:latest", {
      running: true,
      labels: { "com.example.owner": "someone" },
    });

    await harness.provisioner.install();
    await harness.provisioner.settled();

    const status = await harness.provisioner.status();
    assert.equal(status.operation.phase, "error");
    assert.match(status.operation.error ?? "", new RegExp(`${HEADROOM_CONTAINER_NAME} already exists`, "u"));
    const container = harness.docker.containers.get(HEADROOM_CONTAINER_NAME);
    assert.equal(container?.Config.Image, "somebody/else:latest");
    assert.equal(harness.edge.calls.filter((call) => call.method === "PUT").length, 0);
    await assert.rejects(fs.access(statePath(root)), { code: "ENOENT" });
  });
});

test("uninstall removes the container, the volume, the state and the edge contract", async () => {
  await withRoot(async (root) => {
    const harness = setup(root);
    await harness.provisioner.install();
    await harness.provisioner.settled();
    assert.ok(harness.docker.volumes.has(HEADROOM_VOLUME_NAME));
    harness.edge.calls.length = 0;

    const status = await harness.provisioner.uninstall();
    assert.equal(status.container.exists, false);
    assert.equal(status.installed, false);
    assert.equal(status.edge.enabled, false);
    assert.equal(harness.docker.containers.size, 0);
    assert.equal(harness.docker.volumes.has(HEADROOM_VOLUME_NAME), false);
    assert.equal(harness.edge.calls.some((call) => call.method === "DELETE"), true);
    await assert.rejects(fs.access(statePath(root)), { code: "ENOENT" });
  });
});

test("a disabled extension provisions but never turns compression on", async () => {
  await withRoot(async (root) => {
    const harness = setup(root, { enabled: false });
    await harness.provisioner.install();
    await harness.provisioner.settled();
    assert.equal(harness.edge.state().enabled, false);
    assert.equal(harness.edge.calls.filter((call) => call.method === "PUT").length, 0);

    harness.setEnabled(true);
    await harness.provisioner.apply();
    const status = await harness.provisioner.status();
    assert.equal(status.edge.enabled, true);
    assert.equal(status.edge.url, `http://${HEADROOM_CONTAINER_NAME}:8787/v1/compress`);
  });
});

test("reconcile is a no-op on a deployment that never installed Headroom", async () => {
  await withRoot(async (root) => {
    const harness = setup(root, { enabled: false, docker: null });
    await harness.provisioner.reconcile();
    assert.equal(harness.edge.calls.length, 0);
  });
});

test("reconcile stops a running sidecar when the extension is disabled", async () => {
  await withRoot(async (root) => {
    const harness = setup(root, { enabled: true });
    await harness.provisioner.install();
    await harness.provisioner.settled();

    harness.setEnabled(false);
    await harness.provisioner.reconcile();

    const container = harness.docker.containers.get(HEADROOM_CONTAINER_NAME);
    assert.equal(container?.State.Running, false);
    assert.equal(harness.edge.state().enabled, false);
  });
});

test("reconcile reinstalls a sidecar that disappeared and reuses the saved token", async () => {
  await withRoot(async (root) => {
    const harness = setup(root);
    await harness.provisioner.install();
    await harness.provisioner.settled();
    const token = JSON.parse(await fs.readFile(statePath(root), "utf8")).token;
    harness.docker.containers.clear();

    await harness.provisioner.reconcile();
    await harness.provisioner.settled();

    const container = harness.docker.containers.get(HEADROOM_CONTAINER_NAME);
    assert.ok(container);
    assert.ok(container.Config.Env?.includes(`HEADROOM_PROXY_TOKEN=${token}`));
    assert.equal(harness.edge.state().enabled, true);
  });
});

test("a manual endpoint stores its token outside the module settings", async () => {
  await withRoot(async (root) => {
    const harness = setup(root, {
      settings: { manageContainer: false, serverUrl: "http://127.0.0.1:8787" },
    });
    await harness.provisioner.apply("manual-secret");

    const pushed = harness.edge.calls.filter((call) => call.method === "PUT").at(-1);
    assert.deepEqual(pushed?.body, {
      url: "http://127.0.0.1:8787/v1/compress",
      token: "manual-secret",
      mode: null,
      timeoutMs: HEADROOM_DEFAULT_SETTINGS.timeoutMs,
      minBytes: HEADROOM_DEFAULT_SETTINGS.minBytes,
    });
    const status = await harness.provisioner.status();
    assert.equal(status.settings.hasProxyToken, true);
    assert.equal(JSON.stringify(status).includes("manual-secret"), false);
    assert.equal("proxyToken" in JSON.parse(await fs.readFile(statePath(root), "utf8")), false);

    // A restart reuses the stored token instead of losing it with the restart.
    harness.edge.calls.length = 0;
    await harness.provisioner.reconcile();
    assert.deepEqual(harness.edge.calls.filter((call) => call.method === "PUT").at(-1)?.body, pushed?.body);
  });
});

test("a pull failure is reported on the operation without touching the edge", async () => {
  await withRoot(async (root) => {
    const harness = setup(root);
    harness.docker.failPull = "manifest unknown";

    await harness.provisioner.install();
    await harness.provisioner.settled();

    const status = await harness.provisioner.status();
    assert.equal(status.operation.phase, "error");
    assert.equal(status.operation.error, "manifest unknown");
    assert.equal(harness.docker.containers.size, 0);
    assert.equal(harness.edge.calls.filter((call) => call.method === "PUT").length, 0);
  });
});

test("without a reachable Docker daemon the panel explains the limitation", async () => {
  await withRoot(async (root) => {
    const harness = setup(root, { docker: null });
    const status = await harness.provisioner.status();
    assert.equal(status.docker.available, false);
    assert.equal(status.container.exists, false);
    assert.equal(status.installed, false);

    await harness.provisioner.install();
    await harness.provisioner.settled();
    const failed = await harness.provisioner.status();
    assert.equal(failed.operation.phase, "error");
    assert.match(failed.operation.error ?? "", /docker\.sock/u);
  });
});

test("outside a container the sidecar publishes a loopback port", async () => {
  await withRoot(async (root) => {
    const harness = setup(root, { runningInContainer: false, network: null });
    await harness.provisioner.install();
    await harness.provisioner.settled();

    const status = await harness.provisioner.status();
    assert.equal(status.operation.phase, "ready");
    assert.equal(status.service.url, "http://127.0.0.1:32768/v1/compress");
    const container = harness.docker.containers.get(HEADROOM_CONTAINER_NAME);
    assert.equal(container?.NetworkSettings.Ports["8787/tcp"]?.[0]?.HostPort, "32768");
    // A host install does not have a container network to discover.
    assert.deepEqual(Object.keys(container!.NetworkSettings.Networks), ["bridge"]);
  });
});

test("test() probes /readyz with the managed token and refuses an unconfigured service", async () => {
  await withRoot(async (root) => {
    const harness = setup(root);
    await assert.rejects(harness.provisioner.test(), /not configured/u);

    await harness.provisioner.install();
    await harness.provisioner.settled();
    const probe = await harness.provisioner.test();
    assert.deepEqual(probe, { ok: true, status: 200, latencyMs: probe.latencyMs });

    await assert.rejects(harness.provisioner.test("ftp://headroom"), /http\(s\)/u);
  });
});
