import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createAdminRouter, type AdminRoutesOptions } from "./index.js";
import type { ModelAlias, User } from "../../types.js";

const hostAlias: ModelAlias = {
  schemaVersion: 2,
  id: "coding",
  enabled: true,
  description: "Shared host policy",
  rules: [
    {
      id: "primary",
      candidates: [{ model: "gpt-5.4", provider: "openai" }],
      onNoCapacity: "queue",
    },
  ],
};

const memberAlias: ModelAlias = {
  schemaVersion: 2,
  id: "sam-fast",
  ownerId: "usr_1",
  enabled: true,
  rules: [
    {
      id: "primary",
      candidates: [{ model: "gpt-5.4" }],
      onNoCapacity: "queue",
    },
  ],
};

function fakeStore(initial: ModelAlias[]) {
  let aliases = structuredClone(initial);
  const users: Record<string, Partial<User>> = {
    usr_1: {
      id: "usr_1",
      email: "sam@example.test",
      role: "member",
      status: "active",
      allowedModels: ["gpt-5.4"],
    },
    usr_2: {
      id: "usr_2",
      email: "other@example.test",
      role: "member",
      status: "active",
      allowedModels: ["reserved-model"],
    },
  };
  return {
    listModelAliases: async () => structuredClone(aliases),
    upsertModelAlias: async (alias: ModelAlias) => {
      aliases = [...aliases.filter((entry) => entry.id !== alias.id), structuredClone(alias)];
      return alias;
    },
    patchModelAlias: async (id: string, patch: Partial<ModelAlias>) => {
      const index = aliases.findIndex((entry) => entry.id === id);
      if (index === -1) return null;
      aliases[index] = { ...aliases[index], ...patch, id };
      return structuredClone(aliases[index]);
    },
    deleteModelAlias: async (id: string) => {
      const before = aliases.length;
      aliases = aliases.filter((entry) => entry.id !== id);
      return aliases.length < before;
    },
    findUser: async (id: string) => users[id] as User | undefined,
    listUsers: async () => Object.values(users) as User[],
  } as unknown as AdminRoutesOptions["store"];
}

function options(store: AdminRoutesOptions["store"]): AdminRoutesOptions {
  return {
    store,
    oauthStore: {} as AdminRoutesOptions["oauthStore"],
    traceManager: { pageSizeMax: 100 } as AdminRoutesOptions["traceManager"],
    codexProjectRegistry: {} as AdminRoutesOptions["codexProjectRegistry"],
    oauthConfig: {} as AdminRoutesOptions["oauthConfig"],
    openaiBaseUrl: "https://example.test",
    mistralBaseUrl: "https://example.test",
    zaiBaseUrl: "https://example.test",
    codexProjectRegistrationToken: "",
    configuredProxyApiKeys: [],
    storagePaths: {
      accountsPath: "/data/accounts.json",
      oauthStatePath: "/data/oauth.json",
      tracePath: "/data/traces.jsonl",
      traceStatsHistoryPath: "/data/trace-stats.jsonl",
      codexProjectsPath: "/data/projects.json",
    },
  };
}

async function withServer(
  role: "admin" | "member",
  userId: string | undefined,
  initial: ModelAlias[],
  run: (baseUrl: string, store: AdminRoutesOptions["store"]) => Promise<void>,
) {
  const store = fakeStore(initial);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { role, userId, via: role === "admin" ? "token" : "session" };
    next();
  });
  app.use("/admin", createAdminRouter(options(store)));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, store);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("a member only lists their own policies", async () => {
  await withServer("member", "usr_1", [hostAlias, memberAlias], async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/model-aliases`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.modelAliases.map((alias: ModelAlias) => alias.id), ["sam-fast"]);
  });
});

test("an admin still lists shared and member policies", async () => {
  await withServer("admin", undefined, [hostAlias, memberAlias], async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/model-aliases`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.modelAliases.map((alias: ModelAlias) => alias.id).sort(),
      ["coding", "sam-fast"],
    );
  });
});

test("a member creates a private policy owned by them", async () => {
  await withServer("member", "usr_1", [hostAlias], async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/model-aliases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 2,
        id: "My-Fast",
        rules: [{ id: "primary", candidates: [{ model: "gpt-5.4" }] }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.modelAlias.id, "my-fast");
    assert.equal(body.modelAlias.ownerId, "usr_1");
  });
});

test("a member cannot take over a host policy name", async () => {
  await withServer("member", "usr_1", [hostAlias], async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/model-aliases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 2,
        id: "coding",
        rules: [{ id: "primary", candidates: [{ model: "gpt-5.4" }] }],
      }),
    });
    assert.equal(response.status, 409);
  });
});

test("a member cannot shadow a model granted to another account", async () => {
  await withServer("member", "usr_1", [hostAlias], async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/model-aliases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 2,
        id: "reserved-model",
        rules: [{ id: "primary", candidates: [{ model: "gpt-5.4" }] }],
      }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "alias_conflicts_with_model");
  });
});

test("a member cannot route a policy to a model they cannot call", async () => {
  await withServer("member", "usr_1", [hostAlias], async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/model-aliases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 2,
        id: "escape",
        rules: [{ id: "primary", candidates: [{ model: "gpt-5.5-pro" }] }],
      }),
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error, "models_not_allowed");
    assert.deepEqual(body.models, ["gpt-5.5-pro"]);
  });
});

test("a member cannot edit or delete a host or peer policy", async () => {
  const peerAlias: ModelAlias = { ...memberAlias, id: "peer-fast", ownerId: "usr_2" };
  await withServer("member", "usr_1", [hostAlias, peerAlias], async (baseUrl) => {
    for (const id of ["coding", "peer-fast"]) {
      const patched = await fetch(`${baseUrl}/admin/model-aliases/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(patched.status, 403, `PATCH ${id}`);
      const deleted = await fetch(`${baseUrl}/admin/model-aliases/${id}`, {
        method: "DELETE",
      });
      assert.equal(deleted.status, 403, `DELETE ${id}`);
    }
  });
});

test("a member can update their own policy", async () => {
  await withServer("member", "usr_1", [memberAlias], async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/model-aliases/sam-fast`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.modelAlias.enabled, false);
  });
});
