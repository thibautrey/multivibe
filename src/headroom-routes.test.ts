import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { headroomRoutes } from "./headroom-routes.js";
import type { HeadroomProvisioner, HeadroomStatus } from "./headroom-provisioner.js";

function status(): HeadroomStatus {
  return {
    installed: true,
    settings: {
      manageContainer: true,
      serverUrl: "",
      hasProxyToken: true,
      mode: "",
      timeoutMs: 3000,
      minBytes: 4096,
      image: "ghcr.io/headroomlabs-ai/headroom:latest",
    },
    docker: { available: true, socket: "/var/run/docker.sock", version: "27.0.0" },
    container: { name: "multivibe-headroom", exists: true, running: true },
    service: {
      url: "http://multivibe-headroom:8787/v1/compress",
      origin: "managed",
      healthy: true,
      status: 200,
      latencyMs: 4,
    },
    edge: { available: true, enabled: true, url: "http://multivibe-headroom:8787/v1/compress", mode: null },
    operation: { phase: "ready" },
  };
}

function stubProvisioner(calls: string[], overrides: Partial<HeadroomProvisioner> = {}) {
  const record = (name: string) => async () => {
    calls.push(name);
    return status();
  };
  return {
    status: async () => status(),
    install: record("install"),
    start: record("start"),
    stop: record("stop"),
    uninstall: record("uninstall"),
    apply: record("apply"),
    test: async (url?: string) => {
      calls.push(`test:${url ?? ""}`);
      return { ok: true, status: 200, latencyMs: 1 };
    },
    ...overrides,
  } as unknown as HeadroomProvisioner;
}

async function withServer(
  options: Parameters<typeof headroomRoutes>[0],
  run: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  app.use("/admin/headroom", headroomRoutes(options));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("lifecycle routes drive the provisioner and return the fresh status", async () => {
  const calls: string[] = [];
  await withServer({ provisioner: stubProvisioner(calls) }, async (baseUrl) => {
    for (const action of ["install", "start", "stop", "apply"]) {
      const response = await fetch(`${baseUrl}/admin/headroom/${action}`, { method: "POST" });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.module, "multivibe.headroom");
      assert.equal(payload.edge.enabled, true);
    }
    assert.deepEqual(calls, ["install", "start", "stop", "apply"]);
  });
});

test("uninstall also records that the extension must not be reprovisioned", async () => {
  const calls: string[] = [];
  let disabled = 0;
  await withServer(
    {
      provisioner: stubProvisioner(calls),
      onUninstalled: async () => {
        disabled += 1;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/headroom/uninstall`, { method: "POST" });
      assert.equal(response.status, 200);
    },
  );
  assert.deepEqual(calls, ["uninstall"]);
  assert.equal(disabled, 1);
});

test("apply forwards a manual proxy token to the provisioner", async () => {
  const calls: string[] = [];
  const provisioner = stubProvisioner([], {
    apply: async (manualToken?: string) => {
      calls.push(`apply:${manualToken ?? ""}`);
      return status();
    },
  } as Partial<HeadroomProvisioner>);
  await withServer({ provisioner }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/headroom/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proxyToken: " manual-secret " }),
    });
    assert.equal(response.status, 200);
  });
  assert.deepEqual(calls, ["apply:manual-secret"]);
});

test("a failing operation returns its message instead of a status payload", async () => {
  const provisioner = stubProvisioner([], {
    install: async () => {
      throw new Error("manifest unknown");
    },
  } as Partial<HeadroomProvisioner>);
  await withServer({ provisioner }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/headroom/install`, { method: "POST" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "manifest unknown" });
  });
});

test("test forwards an optional URL and reports the probe", async () => {
  const calls: string[] = [];
  await withServer({ provisioner: stubProvisioner(calls) }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/headroom/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:8787" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { probe: { ok: true, status: 200, latencyMs: 1 } });
  });
  assert.deepEqual(calls, ["test:http://127.0.0.1:8787"]);
});

test("the routes report 503 when provisioning is unavailable", async () => {
  await withServer({}, async (baseUrl) => {
    for (const path of ["/admin/headroom", "/admin/headroom/install"]) {
      const response = await fetch(`${baseUrl}${path}`, { method: path.endsWith("install") ? "POST" : "GET" });
      assert.equal(response.status, 503);
    }
  });
});
