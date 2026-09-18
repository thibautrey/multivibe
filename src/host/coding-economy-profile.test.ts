import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_CODING_ECONOMY_GUIDANCE,
  HOST_HARNESS_DEFINITIONS,
  HostHarnessIntegrationManager,
} from "./harness-integrations.js";

const CODEX = HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "openai-codex");

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-codex-economy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  const configPath = path.join(home, ".codex", "config.toml");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), "binary", { mode: 0o755 });
  await fs.writeFile(configPath, 'approval_policy = "on-request"\n\n[history]\npersistence = "save-all"\n');

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({
    object: "list",
    data: [
      { id: "gpt-5.2-codex", metadata: { context_window: 272_000 } },
      { id: "gpt-5.1-codex-mini", metadata: { context_window: 272_000 } },
      { id: "multivibe/coding-parent", metadata: { is_alias: true, alias_targets: ["gpt-5.2-codex"] } },
      { id: "multivibe/coding-worker", metadata: { is_alias: true, alias_targets: ["gpt-5.1-codex-mini"] } },
    ],
  });

  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: CODEX,
    apiKeyForId: () => "mv_codex",
    executableDirectories: [bin],
  });
  await manager.install("openai-codex", { apiKeyId: "key-codex", apiKey: "mv_codex", application: "harness-openai-codex" });
  return { manager, configPath, catalogPath: path.join(home, ".codex", "multivibe-models.json") };
}

test("the coding economy profile is off until it is explicitly enabled", async (t) => {
  const { manager, configPath } = await fixture(t);
  const installed = await fs.readFile(configPath, "utf8");
  assert.ok(!installed.includes("[agents]"), "no subagent block by default");
  assert.ok(!installed.includes("developer_instructions"), "no delegation guidance by default");
  const view = await manager.get("openai-codex");
  assert.deepEqual(view.codexCodingEconomy, undefined);
  assert.match(await fs.readFile(configPath, "utf8"), /approval_policy = "on-request"/);
});

test("enabling publishes the worker subagent and the delegation contract, disabling removes only that block", async (t) => {
  const { manager, configPath } = await fixture(t);
  const enabled = await manager.setCodexCodingEconomy("openai-codex", true, {
    workerModel: "multivibe/coding-worker",
    reasoningEffort: "medium",
  });
  assert.deepEqual(enabled.codexCodingEconomy, { enabled: true, workerModel: "multivibe/coding-worker", reasoningEffort: "medium" });
  assert.equal(enabled.drifted, false);

  const configured = await fs.readFile(configPath, "utf8");
  assert.match(configured, /\[agents\]/);
  assert.match(configured, /default_subagent_model = "multivibe\/coding-worker"/);
  assert.match(configured, /default_subagent_reasoning_effort = "medium"/);
  assert.ok(configured.includes(CODEX_CODING_ECONOMY_GUIDANCE));
  // Root keys must stay before the first table header for TOML to parse.
  const guidanceIndex = configured.indexOf("developer_instructions");
  assert.ok(guidanceIndex < configured.indexOf("[model_providers.multivibe]"));
  // Unrelated user configuration survives the managed rewrite.
  assert.match(configured, /approval_policy = "on-request"/);
  assert.match(configured, /\[history\]/);

  // The virtual worker model is published into the managed Codex catalog.
  const catalog = JSON.parse(await fs.readFile(path.join(path.dirname(configPath), "multivibe-models.json"), "utf8"));
  assert.ok(catalog.models.some((model: { slug: string }) => model.slug === "multivibe/coding-worker"));

  const disabled = await manager.setCodexCodingEconomy("openai-codex", false, {});
  assert.equal(disabled.codexCodingEconomy?.enabled, false);
  const restored = await fs.readFile(configPath, "utf8");
  assert.ok(!restored.includes("[agents]"));
  assert.ok(!restored.includes("developer_instructions"));
  assert.ok(!restored.includes(CODEX_CODING_ECONOMY_GUIDANCE));
  assert.match(restored, /approval_policy = "on-request"/);
  assert.match(restored, /\[history\]/);
});

test("rejects an unusable worker model and other harness ids", async (t) => {
  const { manager } = await fixture(t);
  await assert.rejects(() => manager.setCodexCodingEconomy("openai-codex", true, { workerModel: "" }), /worker model id is required/);
  await assert.rejects(() => manager.setCodexCodingEconomy("openai-codex", true, { workerModel: "bad model" }), /worker model id is required/);
  await assert.rejects(() => manager.setCodexCodingEconomy("openai-codex", true, { workerModel: "gpt-5", reasoningEffort: "extreme" }), /Unsupported reasoning effort/);
  await assert.rejects(() => manager.setCodexCodingEconomy("opencode", true, { workerModel: "gpt-5" }), /only for OpenAI Codex/);
});
