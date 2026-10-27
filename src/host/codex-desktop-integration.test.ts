import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { HOST_HARNESS_DEFINITIONS, HostHarnessIntegrationManager } from "./harness-integrations.js";

const credential = { apiKeyId: "codex-key", apiKey: "mv_canonical_key", application: "harness-openai-codex" };
const token = (expires = Date.now() / 1000 + 300) => `fixture.${Buffer.from(JSON.stringify({ exp: expires })).toString("base64url")}.fixture`;

async function request(url: string, bearer?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }, res => {
      let body = ""; res.on("data", c => body += c); res.on("error", reject);
      res.on("end", () => { try { resolve({ status: res.statusCode!, body: JSON.parse(body) }); } catch (e) { reject(e); } });
    });
    req.setTimeout(3000, () => req.destroy(new Error("request timed out"))); req.on("error", reject);
  });
}

async function fixture(t: TestContext) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-codex-desktop-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, ".codex"));
  const configPath = path.join(home, ".codex/config.toml");
  const authPath = path.join(home, ".codex/auth.json");
  const statePath = path.join(home, ".multivibe/harnesses.json");
  const original = 'model_provider = "multivibe"\nmodel = "gpt-example"\n[history]\npersistence = "none"\n';
  await fs.writeFile(configPath, original);
  const bearer = token();
  const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: bearer, account_id: "fixture-account" } });
  await fs.writeFile(authPath, auth, { mode: 0o600 });
  let upstreamBearer = "";
  const upstream = http.createServer((req, res) => { upstreamBearer = req.headers.authorization ?? ""; res.setHeader("content-type", "application/json"); res.end('{"data":[{"id":"gpt-example"}]}'); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [{ id: "gpt-example" }] });
  t.after(() => { globalThis.fetch = originalFetch; });
  const options = {
    homeDirectory: home, statePath, baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    apiKeyForId: () => credential.apiKey,
    definitions: HOST_HARNESS_DEFINITIONS.filter(x => x.id === "openai-codex"), executableDirectories: [],
  };
  const manager = new HostHarnessIntegrationManager(options);
  t.after(() => manager.stopCatalogSynchronization());
  return { home, configPath, authPath, statePath, original, auth, bearer, manager, options, upstreamBearer: () => upstreamBearer };
}

test("one-click Codex install retains ChatGPT identity, forwards inference, restarts its relay and restores settings", async t => {
  const f = await fixture(t);
  const installed = await f.manager.install("openai-codex", credential);
  assert.equal(installed.configured, true);
  assert.equal(installed.effectiveProvider, "openai");
  assert.deepEqual(installed.codexConnection, { authentication: "ready", relay: "running", restartRequired: true });
  const config = await fs.readFile(f.configPath, "utf8");
  assert.match(config, /model_provider = "openai"/);
  assert.match(config, /\[history\]\npersistence = "none"/);
  assert.equal(await fs.readFile(f.authPath, "utf8"), f.auth);
  const url = installed.effectiveBaseUrl!;
  assert.equal((await request(url + "/models", f.bearer)).status, 200);
  assert.equal(f.upstreamBearer(), `Bearer ${credential.apiKey}`);
  assert.equal((await request(url + "/models", "unrelated")).status, 401);
  f.manager.stopCatalogSynchronization();
  const restarted = new HostHarnessIntegrationManager(f.options);
  t.after(() => restarted.stopCatalogSynchronization());
  const restored = await restarted.get("openai-codex");
  assert.equal(restored.codexConnection?.relay, "running");
  assert.equal(restored.effectiveBaseUrl, url);
  assert.equal((await request(url + "/models", f.bearer)).status, 200);
  await restarted.uninstall("openai-codex");
  assert.equal(await fs.readFile(f.configPath, "utf8"), f.original);
  assert.equal(await fs.readFile(f.authPath, "utf8"), f.auth);
  await assert.rejects(request(url + "/models", f.bearer), /ECONNREFUSED|socket hang up/);
});

test("repair migrates revision-four custom providers without touching authentication or restoration metadata", async t => {
  const f = await fixture(t);
  await f.manager.install("openai-codex", credential);
  const state = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  const savedOriginal = state.installations["openai-codex"].originalContentBase64;
  state.installations["openai-codex"].configurationRevision = 4;
  delete state.installations["openai-codex"].codexBridgePort;
  await fs.writeFile(f.statePath, JSON.stringify(state));
  const installed = await fs.readFile(f.configPath, "utf8");
  await fs.writeFile(f.configPath, installed.replace('model_provider = "openai"', 'model_provider = "multivibe"').replace(/^openai_base_url.*\n/m, ""));
  assert.equal((await f.manager.get("openai-codex")).drifted, true);
  const repaired = await f.manager.repair("openai-codex", credential);
  assert.equal(repaired.configured, true);
  assert.equal(repaired.effectiveProvider, "openai");
  const updated = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  assert.equal(updated.installations["openai-codex"].originalContentBase64, savedOriginal);
  assert.equal(updated.installations["openai-codex"].auxiliaryFiles[0].originalContentBase64, null);
  assert.equal(await fs.readFile(f.authPath, "utf8"), f.auth);
  await f.manager.uninstall("openai-codex");
  await assert.rejects(fs.access(path.join(f.home, ".codex/multivibe-models.json")), /ENOENT/);
});

test("an occupied relay port receives no credentials and explicit repair safely selects a new port", async t => {
  const f = await fixture(t);
  const installed = await f.manager.install("openai-codex", credential);
  const previous = installed.effectiveBaseUrl!;
  f.manager.stopCatalogSynchronization();
  let disclosed = false;
  const unrelated = http.createServer((req, res) => { disclosed ||= Boolean(req.headers.authorization || req.headers["x-api-key"]); res.writeHead(404); res.end('{}'); });
  await new Promise<void>(resolve => unrelated.listen(Number(new URL(previous).port), "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => unrelated.close(() => resolve())));
  const config = await fs.readFile(f.configPath, "utf8");
  const drifted = await f.manager.get("openai-codex");
  assert.equal(drifted.drifted, true);
  assert.equal(drifted.codexConnection?.relay, "unavailable");
  assert.equal(await fs.readFile(f.configPath, "utf8"), config);
  const repaired = await f.manager.repair("openai-codex", credential);
  assert.equal(repaired.configured, true);
  assert.notEqual(repaired.effectiveBaseUrl, previous);
  assert.equal((await request(repaired.effectiveBaseUrl! + "/models", f.bearer)).status, 200);
  assert.equal(disclosed, false);
});

test("another manager can identify the same relay without creating or shutting down a duplicate", async t => {
  const f = await fixture(t);
  const installed = await f.manager.install("openai-codex", credential);
  const second = new HostHarnessIntegrationManager(f.options);
  const view = await second.get("openai-codex");
  assert.equal(view.codexConnection?.relay, "running");
  assert.equal(view.effectiveBaseUrl, installed.effectiveBaseUrl);
  second.stopCatalogSynchronization();
  assert.equal((await request(installed.effectiveBaseUrl! + "/models", f.bearer)).status, 200);
});

test("missing and expired sign-ins are reported without altering authentication or exposing credentials", async t => {
  const f = await fixture(t);
  await fs.unlink(f.authPath);
  const installed = await f.manager.install("openai-codex", credential);
  assert.equal(installed.codexConnection?.authentication, "sign-in-required");
  await assert.rejects(fs.access(f.authPath), /ENOENT/);
  await fs.writeFile(f.authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token(1), account_id: "fixture-account" } }));
  const expired = await f.manager.get("openai-codex");
  assert.equal(expired.codexConnection?.authentication, "expired");
  assert.doesNotMatch(JSON.stringify(expired), /mv_canonical_key|fixture-account/);
});

test("a failed durable install restores files and releases its provisional listener", async t => {
  const f = await fixture(t);
  let allocatedPort = 0;
  (f.manager as any).writeState = async (state: any) => {
    allocatedPort = state.installations["openai-codex"].codexBridgePort;
    throw new Error("simulated state storage failure");
  };
  await assert.rejects(f.manager.install("openai-codex", credential), /state storage failure/);
  assert.equal(await fs.readFile(f.configPath, "utf8"), f.original);
  assert.equal(await fs.readFile(f.authPath, "utf8"), f.auth);
  await assert.rejects(fs.access(path.join(f.home, ".codex/multivibe-models.json")), /ENOENT/);
  assert.ok(allocatedPort > 1024);
  await assert.rejects(request(`http://127.0.0.1:${allocatedPort}/v1/models`, f.bearer), /ECONNREFUSED|socket hang up/);
});

test("a failed disconnect restores the active catalogue and keeps the relay running", async t => {
  const f = await fixture(t);
  const installed = await f.manager.install("openai-codex", credential);
  const catalogPath = path.join(f.home, ".codex/multivibe-models.json");
  const catalog = await fs.readFile(catalogPath, "utf8");
  const config = await fs.readFile(f.configPath, "utf8");
  (f.manager as any).writeState = async () => { throw new Error("simulated disconnect storage failure"); };
  await assert.rejects(f.manager.uninstall("openai-codex"), /disconnect storage failure/);
  assert.equal(await fs.readFile(f.configPath, "utf8"), config);
  assert.equal(await fs.readFile(catalogPath, "utf8"), catalog);
  assert.equal((await f.manager.get("openai-codex")).configured, true);
  assert.equal((await request(installed.effectiveBaseUrl! + "/models", f.bearer)).status, 200);
});

test("one-click routes the selected profile while preserving other profiles and their settings", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.configPath, 'profile = "work"\n[profiles."work"]\nmodel_provider = "legacy-proxy"\nmodel_reasoning_effort = "high"\n[profiles.personal]\nmodel_provider = "personal-provider"\n');
  const installed = await f.manager.install("openai-codex", credential);
  assert.equal(installed.configured, true);
  assert.equal(installed.effectiveProvider, "openai");
  const config = await fs.readFile(f.configPath, "utf8");
  assert.match(config, /\[profiles\."work"\]\nmodel_provider = "openai"\nmodel_reasoning_effort = "high"/);
  assert.match(config, /\[profiles.personal\]\nmodel_provider = "personal-provider"/);
});
