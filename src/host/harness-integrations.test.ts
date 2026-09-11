import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { exec } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  HOST_HARNESS_DEFINITIONS,
  HostHarnessIntegrationManager,
  type HostHarnessDefinition,
} from "./harness-integrations.js";

const requestedNames = [
  "Claude Code", "OpenAI Codex", "OpenCode", "OpenClaw", "Hermes Agent", "Pi", "Goose",
  "OpenHands", "Cline", "Aider", "Qwen Code", "Gemini CLI", "Google Antigravity",
  "GitHub Copilot CLI / Coding Agent", "Kiro / Kiro CLI", "Warp Agent", "Amp", "Crush",
  "Kilo Code", "Roo Code", "Continue", "mini-SWE-agent", "Mistral Vibe", "gptme", "AIChat",
  "ShellGPT", "Fabric", "GPTScript", "Kimi Code CLI", "Pochi", "Zed Agent Panel", "JetBrains Junie",
  "Amazon Q Developer CLI", "Sourcegraph Cody", "Tabby", "Trae", "Qoder", "CodeRabbit CLI",
  "Qodo Merge / PR-Agent", "GPT Engineer", "AiderDesk", "PearAI", "Devika", "smol developer",
  "SWE-smith", "SWE-ReX", "Agentless", "Open Interpreter", "SWE-agent", "AutoCodeRover",
  "Mentat", "GPT-Pilot", "Plandex", "Cursor Agent", "Windsurf Cascade", "Devin", "Pythagora",
  "Agent Zero", "OpenManus", "Manus", "AutoGen", "CrewAI", "LangGraph", "smolagents",
  "Letta", "AutoGPT", "BabyAGI", "MetaGPT", "SuperAGI", "AgentGPT", "CAMEL", "PydanticAI",
  "Mastra", "Agno", "Semantic Kernel", "LlamaIndex Agents", "LangChain Agents", "deepseek-harness",
];

test("the host registry covers every requested harness exactly once", () => {
  assert.deepEqual(
    [...HOST_HARNESS_DEFINITIONS].map((entry) => entry.name).sort(),
    requestedNames.sort(),
  );
  assert.equal(new Set(HOST_HARNESS_DEFINITIONS.map((entry) => entry.id)).size, HOST_HARNESS_DEFINITIONS.length);
});

test("rejects a relative host home directory", () => {
  assert.throws(() => new HostHarnessIntegrationManager({
    homeDirectory: "relative-home",
    statePath: "/tmp/multivibe-harness-state.json",
    baseUrl: "http://127.0.0.1:1455",
    definitions: [],
  }), /home directory must be absolute/);
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-harness-"));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "example-agent"), "#!/bin/sh\n", { mode: 0o755 });
  const definition: HostHarnessDefinition = {
    id: "example",
    name: "Example Agent",
    category: "agent",
    executables: ["example-agent"],
    footprints: [".example"],
    configuration: {
      relativePath: ".example/settings.json",
      render(current, context) {
        const value = current ? JSON.parse(current) : {};
        value.multivibe = { baseUrl: `${context.baseUrl}/v1`, apiKey: context.apiKey };
        return `${JSON.stringify(value, null, 2)}\n`;
      },
      isConfigured(current, baseUrl) {
        return current.includes(`${baseUrl}/v1`);
      },
    },
  };
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: [definition],
    executableDirectories: [bin],
  });
  return { root, home, manager };
}

function mockCodexModelCatalog(t: TestContext, modelIds = ["model-a", "gpt-5.5"]) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ data: modelIds.map((id) => ({ id })) });
}

test("detects without executing, installs privately, and restores the exact previous file", async (t) => {
  const { root, home, manager } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(home, ".example", "settings.json");
  const original = '{\n  "theme": "dark"\n}\n';
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, original, { mode: 0o644 });

  const before = await manager.get("example");
  assert.equal(before.detected, true);
  assert.equal(before.canInstall, true);

  const installed = await manager.install("example", {
    apiKeyId: "key-1",
    apiKey: "mv_private-test-key",
    application: "harness-example",
  });
  assert.equal(installed.configured, true);
  assert.equal(installed.managed, true);
  assert.equal(installed.canUninstall, true);
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  assert.match(await fs.readFile(configPath, "utf8"), /mv_private-test-key/);
  assert.doesNotMatch(
    await fs.readFile(path.join(home, ".multivibe", "harnesses.json"), "utf8"),
    /mv_private-test-key/,
  );

  const removed = await manager.uninstall("example");
  assert.equal(removed.apiKeyId, "key-1");
  assert.equal(await fs.readFile(configPath, "utf8"), original);
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o644);
});

test("OpenCode installation synchronizes every safe model from MultiVibe", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-opencode-models-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  const configPath = path.join(home, ".config", "opencode", "opencode.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "opencode"), "binary", { mode: 0o755 });
  await fs.writeFile(configPath, `${JSON.stringify({
    model: "litellm/existing-model",
    provider: { litellm: { name: "Keep me" } },
  })}\n`);

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests += 1;
    assert.equal(String(input), "http://127.0.0.1:1455/v1/models");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer mv_opencode");
    assert.equal(init?.redirect, "error");
    return Response.json({
      object: "list",
      data: [
        { id: "gpt-5.6-luna" },
        { id: "gpt-5.5" },
        { id: "local/model" },
        { id: "gpt-5.5" },
        { id: "\u0000invalid" },
      ],
    });
  };

  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "opencode"),
    executableDirectories: [bin],
  });

  await manager.install("opencode", {
    apiKeyId: "key-opencode",
    apiKey: "mv_opencode",
    application: "harness-opencode",
  });

  const configured = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(configured.model, "multivibe/gpt-5.5");
  assert.deepEqual(Object.keys(configured.provider.multivibe.models), [
    "gpt-5.6-luna",
    "gpt-5.5",
    "local/model",
  ]);
  assert.equal(configured.provider.multivibe.options.baseURL, "http://127.0.0.1:1455/v1");
  assert.deepEqual(configured.provider.litellm, { name: "Keep me" });
  assert.equal(requests, 1);
});

test("all model-aware harnesses synchronize the live MultiVibe catalog", async (t) => {
  const modelIds = ["gpt-5.6-luna", "gpt-5.5", "local/model"];
  const catalogHarnesses = new Set(["openclaw", "pi", "crush", "continue"]);
  const harnessIds = [
    "openclaw", "pi", "crush", "continue", "hermes-agent", "goose", "openhands",
    "aider", "mini-swe-agent", "gptme", "shell-gpt", "open-interpreter", "agent-zero", "autogpt",
  ];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  for (const id of harnessIds) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `multivibe-${id}-models-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const bin = path.join(home, "bin");
    const definition = HOST_HARNESS_DEFINITIONS.find((entry) => entry.id === id)!;
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, definition.executables[0]), "binary", { mode: 0o755 });

    let requests = 0;
    globalThis.fetch = async (input, init) => {
      requests += 1;
      assert.equal(String(input), "http://127.0.0.1:1455/v1/models");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer mv_all_harnesses");
      return Response.json({ object: "list", data: modelIds.map((model) => ({ id: model })) });
    };

    const manager = new HostHarnessIntegrationManager({
      homeDirectory: home,
      statePath: path.join(home, ".multivibe", "harnesses.json"),
      baseUrl: "http://127.0.0.1:1455",
      definitions: [definition],
      executableDirectories: [bin],
    });
    await manager.install(id, {
      apiKeyId: `key-${id}`,
      apiKey: "mv_all_harnesses",
      application: `harness-${id}`,
    });

    const configPath = path.join(home, definition.configuration!.relativePath);
    const configured = await fs.readFile(configPath, "utf8");
    assert.equal(requests, 1, `${id} should discover the catalog once`);
    assert.match(configured, /gpt-5\.5|gpt-5\.6-luna/);
    if (catalogHarnesses.has(id)) {
      for (const model of modelIds) assert.match(configured, new RegExp(model.replace("/", "\\/")));
    }
  }
});

test("mini-SWE-agent uses its platform config and preserves unrelated dotenv settings", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-mini-swe-agent-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  const definition = HOST_HARNESS_DEFINITIONS.find((entry) => entry.id === "mini-swe-agent")!;
  const configPath = path.join(home, definition.configuration!.relativePath);
  const original = 'MSWEA_GLOBAL_CALL_LIMIT="25"\n';
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(path.join(bin, "mini"), "binary", { mode: 0o755 });
  await fs.writeFile(configPath, original);

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ data: [{ id: "gpt-5.6-luna" }, { id: "gpt-5.5" }] });

  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: [definition],
    executableDirectories: [bin],
  });
  assert.equal((await manager.get("mini-swe-agent")).detectedBy.includes("command:mini"), true);

  const installed = await manager.install("mini-swe-agent", {
    apiKeyId: "key-mini-swe-agent",
    apiKey: "mv_mini_swe_agent",
    application: "harness-mini-swe-agent",
  });
  assert.equal(installed.configured, true);
  assert.equal(installed.configPath, `~/${definition.configuration!.relativePath}`);
  const configured = await fs.readFile(configPath, "utf8");
  assert.match(configured, /MSWEA_GLOBAL_CALL_LIMIT="25"/);
  assert.match(configured, /MSWEA_MODEL_NAME="openai\/gpt-5\.5"/);
  assert.match(configured, /OPENAI_API_KEY="mv_mini_swe_agent"/);
  assert.match(configured, /OPENAI_API_BASE="http:\/\/127\.0\.0\.1:1455\/v1"/);
  assert.match(configured, /OPENAI_BASE_URL="http:\/\/127\.0\.0\.1:1455\/v1"/);
  assert.match(configured, /MSWEA_COST_TRACKING="ignore_errors"/);

  await manager.uninstall("mini-swe-agent");
  assert.equal(await fs.readFile(configPath, "utf8"), original);
});

test("gptme installs a named MultiVibe provider and safely updates an existing env table", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-gptme-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  const configPath = path.join(home, ".config", "gptme", "config.toml");
  const original = '[env]\nMODEL = "openai/gpt-4o"\nEDITOR = "vim"\n\n[[providers]]\nname = "existing"\nbase_url = "http://example.test/v1"\n';
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(path.join(bin, "gptme"), "binary", { mode: 0o755 });
  await fs.writeFile(configPath, original);

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ data: [{ id: "gpt-5.5" }] });
  const definition = HOST_HARNESS_DEFINITIONS.find((entry) => entry.id === "gptme")!;
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: [definition],
    executableDirectories: [bin],
  });

  await manager.install("gptme", { apiKeyId: "key-gptme", apiKey: "mv_gptme", application: "harness-gptme" });
  const configured = await fs.readFile(configPath, "utf8");
  assert.match(configured, /\[env\]\nMODEL = "multivibe\/gpt-5\.5"\nEDITOR = "vim"/);
  assert.match(configured, /\[\[providers\]\]\nname = "existing"/);
  assert.match(configured, /name = "multivibe"\nbase_url = "http:\/\/127\.0\.0\.1:1455\/v1"/);
  assert.match(configured, /api_key = "mv_gptme"/);
  await manager.uninstall("gptme");
  assert.equal(await fs.readFile(configPath, "utf8"), original);
});

test("ShellGPT preserves its runtime settings while selecting MultiVibe", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-shell-gpt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  const configPath = path.join(home, ".config", "shell_gpt", ".sgptrc");
  const original = "REQUEST_TIMEOUT=90\n";
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(path.join(bin, "sgpt"), "binary", { mode: 0o755 });
  await fs.writeFile(configPath, original);

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ data: [{ id: "gpt-5.5" }] });
  const definition = HOST_HARNESS_DEFINITIONS.find((entry) => entry.id === "shell-gpt")!;
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: [definition],
    executableDirectories: [bin],
  });

  await manager.install("shell-gpt", { apiKeyId: "key-shell-gpt", apiKey: "mv_shell_gpt", application: "harness-shell-gpt" });
  const configured = await fs.readFile(configPath, "utf8");
  assert.match(configured, /^REQUEST_TIMEOUT=90/m);
  assert.match(configured, /API_BASE_URL="http:\/\/127\.0\.0\.1:1455\/v1"/);
  assert.match(configured, /DEFAULT_MODEL="gpt-5\.5"/);
  await manager.uninstall("shell-gpt");
  assert.equal(await fs.readFile(configPath, "utf8"), original);
});

test("marks old OpenCode installations for repair and refreshes their model catalog", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-opencode-repair-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  const configPath = path.join(home, ".config", "opencode", "opencode.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(path.join(home, ".multivibe"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "opencode"), "binary", { mode: 0o755 });
  const oldConfig = `${JSON.stringify({
    model: "multivibe/gpt-5.5",
    provider: {
      multivibe: {
        npm: "@ai-sdk/openai-compatible",
        name: "MultiVibe Host",
        options: { baseURL: "http://127.0.0.1:1455/v1", apiKey: "mv_opencode" },
        models: { "gpt-5.5": { name: "gpt-5.5" } },
      },
    },
  })}\n`;
  await fs.writeFile(configPath, oldConfig);
  await fs.writeFile(
    path.join(home, ".multivibe", "harnesses.json"),
    `${JSON.stringify({
      schemaVersion: "multivibe-host-harness-integrations-v1",
      installations: {
        opencode: {
          configPath,
          originalContentBase64: null,
          originalMode: null,
          installedSha256: createHash("sha256").update(oldConfig).digest("hex"),
          apiKeyId: "key-opencode",
          application: "harness-opencode",
          installedAt: 1,
        },
      },
    })}\n`,
  );

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "http://127.0.0.1:1455/v1/models");
    return Response.json({ object: "list", data: [{ id: "gpt-5.6-luna" }, { id: "gpt-5.5" }] });
  };

  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "opencode"),
    executableDirectories: [bin],
  });
  const before = await manager.get("opencode");
  assert.equal(before.managed, true);
  assert.equal(before.drifted, true);
  assert.equal(before.repairable, true);

  await manager.repair("opencode", {
    apiKeyId: "key-opencode",
    apiKey: "mv_opencode",
    application: "harness-opencode",
  });
  const repaired = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.deepEqual(Object.keys(repaired.provider.multivibe.models), ["gpt-5.6-luna", "gpt-5.5"]);
  assert.equal((await manager.get("opencode")).drifted, false);
});

test("uninstall refuses to overwrite user changes made after installation", async (t) => {
  const { root, home, manager } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await manager.install("example", {
    apiKeyId: "key-2",
    apiKey: "mv_private-test-key",
    application: "harness-example",
  });
  const configPath = path.join(home, ".example", "settings.json");
  const changed = `${await fs.readFile(configPath, "utf8")}\n`;
  await fs.writeFile(configPath, changed);
  await assert.rejects(() => manager.uninstall("example"), /changed after MultiVibe was installed/);
  assert.equal(await fs.readFile(configPath, "utf8"), changed);
  assert.equal((await manager.get("example")).drifted, true);
});

test("Codex installation uses the built-in OpenAI provider catalog and restores the original workspace", async (t) => {
  mockCodexModelCatalog(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-codex-harness-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), "binary", { mode: 0o755 });
  const configPath = path.join(home, ".codex", "config.toml");
  const original = 'model_provider = "openai"\nmodel_catalog_json = "/tmp/static-models.json"\napproval_policy = "on-request"\n\n[history]\npersistence = "none"\n';
  await fs.writeFile(configPath, original);
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "openai-codex"),
    executableDirectories: [bin],
  });

  await manager.install("openai-codex", { apiKeyId: "key-3", apiKey: "mv_codex", application: "harness-openai-codex" });
  const configured = await fs.readFile(configPath, "utf8");
  assert.match(configured, /model_provider = "openai"/);
  assert.match(configured, /openai_base_url = "http:\/\/127\.0\.0\.1:1455\/v1"/);
  assert.match(configured, /approval_policy = "on-request"/);
  assert.match(configured, /model_catalog_json = /);
  assert.doesNotMatch(configured, /model_providers\.multivibe|experimental_bearer_token/);
  const firstTable = configured.search(/^\[/m);
  const rootProvider = configured.indexOf('model_provider = "openai"');
  assert.ok(rootProvider >= 0 && rootProvider < firstTable, "Codex provider must remain at the TOML root");
  assert.equal((configured.match(/^model_provider\s*=/gm) ?? []).length, 1);
  const catalog = JSON.parse(await fs.readFile(path.join(home, ".codex", "multivibe-models.json"), "utf8"));
  assert.deepEqual(catalog.models.map((model: any) => model.slug), ["model-a", "gpt-5.5"]);
  await manager.uninstall("openai-codex");
  assert.equal(await fs.readFile(configPath, "utf8"), original);
  await assert.rejects(fs.readFile(path.join(home, ".codex", "multivibe-models.json"), "utf8"), /ENOENT/);
});

test("Codex repair refreshes a drifted MultiVibe catalog", async (t) => {
  mockCodexModelCatalog(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-codex-static-catalog-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), "binary", { mode: 0o755 });
  const configPath = path.join(home, ".codex", "config.toml");
  await fs.writeFile(configPath, "model = \"gpt-5.6-luna\"\n");
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "openai-codex"),
    executableDirectories: [bin],
  });
  const credential = { apiKeyId: "key-static-catalog", apiKey: "mv_static", application: "harness-openai-codex" };
  await manager.install("openai-codex", credential);
  const changed = (await fs.readFile(configPath, "utf8")).replace(
    "model_catalog_json = ",
    "model_catalog_json = \"/tmp/static-models.json\" # replaced ",
  );
  await fs.writeFile(configPath, changed);

  const drifted = await manager.get("openai-codex");
  assert.equal(drifted.configured, false);
  assert.equal(drifted.drifted, true);
  assert.equal(drifted.repairable, true);
  assert.match(drifted.configurationIssue ?? "", /does not point to the MultiVibe catalog/);

  const repaired = await manager.repair("openai-codex", credential);
  assert.equal(repaired.configured, true);
  assert.equal(repaired.drifted, false);
  assert.match(await fs.readFile(configPath, "utf8"), /model_catalog_json = .*multivibe-models\.json/);
});

test("Codex repair preserves a table inserted inside the legacy managed block", async (t) => {
  mockCodexModelCatalog(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-codex-repair-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), "binary", { mode: 0o755 });
  const configPath = path.join(home, ".codex", "config.toml");
  await fs.writeFile(configPath, [
    "model = \"gpt-5.6-luna\"",
    "",
    "# >>> MultiVibe Host >>>",
    "model_provider = \"multivibe\"",
    "",
    "[plugins.\"sites@openai-bundled\"]",
    "enabled = true",
    "",
    "[model_providers.multivibe]",
    "name = \"MultiVibe Host\"",
    "base_url = \"http://192.168.1.149:1455/v1\"",
    "# <<< MultiVibe Host <<<",
    "",
    "[history]",
    "persistence = \"none\"",
    "",
  ].join("\n"));
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "openai-codex"),
    executableDirectories: [bin],
  });

  await manager.install("openai-codex", { apiKeyId: "key-repair", apiKey: "mv_repair", application: "harness-openai-codex" });
  const repaired = await fs.readFile(configPath, "utf8");
  assert.match(repaired, /\[plugins\.\"sites@openai-bundled\"\]/);
  assert.match(repaired, /enabled = true/);
  assert.doesNotMatch(repaired, /192\.168\.1\.149:1455/);
  assert.equal((await manager.get("openai-codex")).configured, true);
});

test("Codex ignores unrelated configuration changes when evaluating connection health", async (t) => {
  mockCodexModelCatalog(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-codex-reconcile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), "binary", { mode: 0o755 });
  const configPath = path.join(home, ".codex", "config.toml");
  await fs.writeFile(configPath, "model = \"gpt-5.6-luna\"\n");
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "openai-codex"),
    executableDirectories: [bin],
  });
  const credential = { apiKeyId: "key-reconcile", apiKey: "mv_reconcile", application: "harness-openai-codex" };
  await manager.install("openai-codex", credential);
  await fs.appendFile(configPath, "\n[plugins.\"sites@openai-bundled\"]\nenabled = true\n");
  const connected = await manager.get("openai-codex");
  assert.equal(connected.configured, true);
  assert.equal(connected.drifted, false);
  assert.equal(connected.canUninstall, false);
  assert.match(await fs.readFile(configPath, "utf8"), /\[plugins\.\"sites@openai-bundled\"\]/);
});

test("Codex repairs managed configuration drift without removing unrelated changes", async (t) => {
  mockCodexModelCatalog(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-codex-managed-drift-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), "binary", { mode: 0o755 });
  const configPath = path.join(home, ".codex", "config.toml");
  await fs.writeFile(configPath, "model = \"gpt-5.6-luna\"\n");
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "openai-codex"),
    executableDirectories: [bin],
  });
  const credential = { apiKeyId: "key-managed-drift", apiKey: "mv_managed_drift", application: "harness-openai-codex" };
  await manager.install("openai-codex", credential);
  const changed = (await fs.readFile(configPath, "utf8"))
    .replace('openai_base_url = "http://127.0.0.1:1455/v1"', 'openai_base_url = "http://127.0.0.1:9999/v1"');
  await fs.writeFile(configPath, `${changed}\n[plugins.\"sites@openai-bundled\"]\nenabled = true\n`);
  const drifted = await manager.get("openai-codex");
  assert.equal(drifted.configured, false);
  assert.equal(drifted.drifted, true);
  assert.equal(drifted.repairable, true);
  assert.equal(drifted.canUninstall, false);

  const repaired = await manager.repair("openai-codex", credential);
  assert.equal(repaired.configured, true);
  assert.equal(repaired.drifted, false);
  assert.equal(repaired.canUninstall, true);
  assert.match(await fs.readFile(configPath, "utf8"), /\[plugins\.\"sites@openai-bundled\"\]/);
});

test("Codex detects a changed managed model catalog", async (t) => {
  mockCodexModelCatalog(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-codex-credential-drift-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), "binary", { mode: 0o755 });
  const configPath = path.join(home, ".codex", "config.toml");
  await fs.writeFile(configPath, "model = \"gpt-5.6-luna\"\n");
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "openai-codex"),
    executableDirectories: [bin],
  });
  const credential = { apiKeyId: "key-credential-drift", apiKey: "mv_expected", application: "harness-openai-codex" };
  await manager.install("openai-codex", credential);
  const catalogPath = path.join(home, ".codex", "multivibe-models.json");
  await fs.writeFile(catalogPath, '{"models":[]}\n');

  const drifted = await manager.get("openai-codex");
  assert.equal(drifted.configured, false);
  assert.equal(drifted.drifted, true);
  assert.equal(drifted.repairable, true);
  assert.equal(drifted.canUninstall, false);
});

test("Codex accepts brackets inside quoted TOML table keys", async (t) => {
  mockCodexModelCatalog(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-codex-quoted-header-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), "binary", { mode: 0o755 });
  const configPath = path.join(home, ".codex", "config.toml");
  await fs.writeFile(configPath, "model = \"gpt-5.6-luna\"\n");
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "openai-codex"),
    executableDirectories: [bin],
  });
  const credential = { apiKeyId: "key-quoted-header", apiKey: "mv_quoted_header", application: "harness-openai-codex" };
  await manager.install("openai-codex", credential);
  await fs.appendFile(configPath, '\n[hooks.state."browser@openai-bundled:plugin.json#hooks[0]:stop:0:0"]\nenabled = true\n');

  const drifted = await manager.get("openai-codex");
  assert.equal(drifted.drifted, false);
  assert.equal(drifted.repairable, true);
  assert.equal(drifted.canUninstall, false);

  assert.match(await fs.readFile(configPath, "utf8"), /hooks\[0\]:stop:0:0/);
});

test("Codex reports profile overrides without hiding a correct default provider", async (t) => {
  mockCodexModelCatalog(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-codex-profile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), "binary", { mode: 0o755 });
  const configPath = path.join(home, ".codex", "config.toml");
  await fs.writeFile(configPath, "[profiles.normal]\nmodel_provider = \"litellm\"\n");
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: home,
    statePath: path.join(home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455",
    definitions: HOST_HARNESS_DEFINITIONS.filter((entry) => entry.id === "openai-codex"),
    executableDirectories: [bin],
  });
  const installed = await manager.install("openai-codex", { apiKeyId: "key-profile", apiKey: "mv_profile", application: "harness-openai-codex" });
  assert.equal(installed.configured, true);
  assert.match(installed.configurationIssue ?? "", /normal=litellm/);
});

async function trackingFixture() {
  const fixtureValue = await fixture();
  const definition: HostHarnessDefinition = {
    id: "openai-codex", name: "Codex", category: "cli", executables: [], footprints: [".codex"],
    configuration: {
      relativePath: ".codex/config.toml",
      render: () => 'model_provider = "multivibe"\n',
      isConfigured: (value) => value.includes('"multivibe"'),
    },
  };
  await fs.mkdir(path.join(fixtureValue.home, ".codex"));
  const manager = new HostHarnessIntegrationManager({
    homeDirectory: fixtureValue.home,
    statePath: path.join(fixtureValue.home, ".multivibe", "harnesses.json"),
    baseUrl: "http://127.0.0.1:1455", projectRegistrationToken: "fixture-registration-token",
    definitions: [definition], executableDirectories: [],
  });
  return { ...fixtureValue, manager };
}

const trackingCredential = { apiKeyId: "fixture-key", apiKey: "fixture-secret", application: "harness-openai-codex" };

test("connecting Codex installs private tracking without downloads and restores unrelated hooks on disconnect", async (t) => {
  const { root, home, manager } = await trackingFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hooksPath = path.join(home, ".codex/hooks.json");
  const original = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo existing" }] }], Stop: [] } };
  await fs.writeFile(hooksPath, JSON.stringify(original));
  assert.equal((await manager.install("openai-codex", trackingCredential)).projectTracking, "installed");
  const configPath = path.join(home, ".codex/multivibe-project.json");
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(configPath, "utf8")).token, "fixture-registration-token");
  await manager.enableProjectTracking("openai-codex");
  assert.equal(JSON.parse(await fs.readFile(hooksPath, "utf8")).hooks.SessionStart.length, 2);
  await manager.uninstall("openai-codex");
  assert.deepEqual(JSON.parse(await fs.readFile(hooksPath, "utf8")), original);
  await assert.rejects(fs.stat(configPath), { code: "ENOENT" });
});

test("existing Codex connections can add tracking without changing provider configuration", async (t) => {
  const { root, home, manager } = await trackingFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(home, ".codex/config.toml");
  const original = 'model_provider = "custom"\n';
  await fs.writeFile(configPath, original);
  assert.equal((await manager.enableProjectTracking("openai-codex")).projectTracking, "installed");
  assert.equal(await fs.readFile(configPath, "utf8"), original);
  await fs.writeFile(path.join(home, ".codex/hooks/multivibe-project-hook.mjs"), "changed");
  assert.equal((await manager.get("openai-codex")).projectTracking, "not-installed");
});

test("invalid existing hooks roll back the provider connection without overwriting user data", async (t) => {
  const { root, home, manager } = await trackingFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hooksPath = path.join(home, ".codex/hooks.json");
  await fs.writeFile(hooksPath, "invalid JSON");
  await assert.rejects(manager.install("openai-codex", trackingCredential), /valid JSON/);
  assert.equal(await fs.readFile(hooksPath, "utf8"), "invalid JSON");
  await assert.rejects(fs.stat(path.join(home, ".codex/config.toml")), { code: "ENOENT" });
  assert.equal((await manager.get("openai-codex")).managed, false);
});

test("tracking setup refuses symlinked hook files", async (t) => {
  const { root, home, manager } = await trackingFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside.json");
  await fs.writeFile(outside, "{}");
  await fs.symlink(outside, path.join(home, ".codex/hooks.json"));
  await assert.rejects(manager.enableProjectTracking("openai-codex"), /regular file|symbolic|symlink/i);
  assert.equal(await fs.readFile(outside, "utf8"), "{}");
});


test("the installed command registers a real session without exposing credentials in the command", async (t) => {
  const { root, home, manager } = await trackingFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let registration: any;
  let token: string | undefined;
  const server = http.createServer(async (request, response) => {
    assert.equal(request.url, "/admin/codex-sessions");
    token = request.headers["x-codex-project-token"] as string;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    registration = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(201).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await manager.enableProjectTracking("openai-codex");
  const configPath = path.join(home, ".codex/multivibe-project.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await fs.writeFile(configPath, JSON.stringify(config));
  const manifest = JSON.parse(await fs.readFile(path.join(home, ".codex/hooks.json"), "utf8"));
  const command = manifest.hooks.SessionStart[0].hooks[0].command;
  assert.equal(command.includes(config.token), false);
  await new Promise<void>((resolve, reject) => {
    const child = exec(command, { timeout: 5000 }, (error) => error ? reject(error) : resolve());
    child.stdin!.end(JSON.stringify({ session_id: "fixture-session", cwd: home, source: "startup" }));
  });
  assert.equal(token, "fixture-registration-token");
  assert.equal(registration?.sessionId, "fixture-session");
  assert.equal(registration?.projectRoot, home);
});
