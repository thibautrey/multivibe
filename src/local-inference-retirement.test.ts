import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AccountStore } from "./store.js";
import type { Account } from "./types.js";

test("upgrades disable generated inference accounts while preserving provider accounts and model files", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-retired-inference-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "accounts.json");
  const model = path.join(directory, "user-model.gguf");
  await fs.writeFile(model, "user model");
  const legacy: Account = {
    id: "local-runtime-ollama", provider: "openai-compatible", enabled: true, accessToken: "",
    location: "local", baseUrl: "http://127.0.0.1:11434",
    localRuntime: { source: "multivibe-local-discovery", adapter: "ollama", endpoint: "http://127.0.0.1:11434", authentication: "none", confirmedModelIds: ["old-model"] },
  };
  const remote: Account = { id: "remote-provider", provider: "openai-compatible", accessToken: "provider-key", enabled: true, baseUrl: "https://provider.example.com" };
  await fs.writeFile(file, JSON.stringify({ accounts: [legacy, remote] }));
  const store = new AccountStore(file);
  await store.init();
  assert.equal((await store.listAccounts()).find(a => a.id === legacy.id)?.enabled, false);
  assert.equal((await store.listAccounts()).find(a => a.id === remote.id)?.enabled, true);
  assert.deepEqual((await store.listAccounts()).find(a => a.id === legacy.id)?.localRuntime, legacy.localRuntime);
  await store.patchAccount(legacy.id, { enabled: true });
  await store.flushIfDirty();
  const reloaded = new AccountStore(file);
  await reloaded.init();
  assert.equal((await reloaded.listAccounts()).find(a => a.id === legacy.id)?.enabled, false);
  assert.equal((await reloaded.listAccounts()).find(a => a.id === remote.id)?.accessToken, "provider-key");
  assert.equal(await fs.readFile(model, "utf8"), "user model");
});
