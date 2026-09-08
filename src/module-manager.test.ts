import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModuleManager, normalizePublicGitHubUrl, readModuleManifest } from "./module-manager.js";

test("normalizes public GitHub HTTPS repository URLs", () => {
  assert.equal(
    normalizePublicGitHubUrl("https://github.com/example/module"),
    "https://github.com/example/module.git",
  );
  assert.equal(
    normalizePublicGitHubUrl("https://github.com/example/module.git"),
    "https://github.com/example/module.git",
  );
});

test("rejects SSH, credentials, non-GitHub hosts, and extra paths", () => {
  for (const value of [
    "git@github.com:example/module.git",
    "https://token@github.com/example/module",
    "https://gitlab.com/example/module",
    "https://github.com/example/module/tree/main",
    "file:///tmp/module",
  ]) {
    assert.throws(() => normalizePublicGitHubUrl(value));
  }
});

test("clears restart requirements and loads enabled plugins on startup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-modules-"));
  const moduleRoot = path.join(root, "checkouts", "com.example.restart");
  await fs.mkdir(path.join(moduleRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(moduleRoot, "package.json"), JSON.stringify({ type: "module" }));
  await fs.writeFile(path.join(moduleRoot, "multivibe.module.json"), JSON.stringify({
    id: "com.example.restart",
    name: "Restart test",
    version: "1.0.0",
    apiVersion: 1,
    description: "Test plugin",
    entrypoint: "dist/index.js",
    hooks: [],
    repository: "https://github.com/example/restart.git",
  }));
  await fs.writeFile(path.join(moduleRoot, "dist", "index.js"), "export default {};\n");
  await fs.writeFile(path.join(root, "modules-lock.json"), JSON.stringify([{
    id: "com.example.restart",
    origin: "https://github.com/example/restart.git",
    commit: "abc123",
    enabled: true,
    settings: {},
    source: "external",
    restartRequired: true,
  }]));

  try {
    const manager = new ModuleManager(root);
    await manager.initialize();
    const [plugin] = manager.list();
    assert.equal(plugin.restartRequired, undefined);
    assert.equal(plugin.loaded, true);
    assert.equal(plugin.healthy, true);
    const persisted = JSON.parse(await fs.readFile(path.join(root, "modules-lock.json"), "utf8"));
    assert.equal(persisted[0].restartRequired, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("loads the persisted marketplace and exposes manifest categories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-marketplace-"));
  const entry = {
    id: "com.example.catalog",
    origin: "https://github.com/example/catalog.git",
    commit: "abc123",
    submittedAt: "2026-09-02T00:00:00.000Z",
    manifest: { id: "com.example.catalog", name: "Catalog", version: "1.0.0", apiVersion: 1, description: "Catalog plugin", entrypoint: "dist/index.js", hooks: [], repository: "https://github.com/example/catalog.git", categories: ["Automation"] },
  };
  await fs.writeFile(path.join(root, "marketplace.json"), JSON.stringify([entry]));
  try {
    const manager = new ModuleManager(root);
    await manager.initialize();
    assert.deepEqual(manager.marketplaceList(), [entry]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("keeps the bundled inference module disabled in the native control-plane profile", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-native-modules-"));
  const bundledRoot = path.join(root, "bundled-security");
  await fs.mkdir(path.join(bundledRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(bundledRoot, "package.json"), JSON.stringify({ type: "module" }));
  await fs.writeFile(path.join(bundledRoot, "multivibe.module.json"), JSON.stringify({
    id: "com.multivibe.security",
    name: "Security",
    version: "1.0.0",
    apiVersion: 1,
    description: "Test bundled inference module",
    entrypoint: "dist/index.js",
    hooks: ["request.beforeUpstream"],
    repository: "https://github.com/example/security.git",
    defaultSettings: { semanticMode: "auto" },
  }));
  await fs.writeFile(path.join(bundledRoot, "dist", "index.js"), "export default {};\n");

  try {
    const firstStart = new ModuleManager(root, bundledRoot, false);
    await firstStart.initialize();
    assert.equal(firstStart.list()[0].enabled, false);
    assert.equal(firstStart.list()[0].loaded, false);

    const lockPath = path.join(root, "modules-lock.json");
    const persisted = JSON.parse(await fs.readFile(lockPath, "utf8"));
    persisted[0].enabled = true;
    await fs.writeFile(lockPath, JSON.stringify(persisted));

    const upgradedStart = new ModuleManager(root, bundledRoot, false);
    await upgradedStart.initialize();
    assert.equal(upgradedStart.list()[0].enabled, false);
    assert.equal(upgradedStart.list()[0].loaded, false);
    assert.deepEqual(upgradedStart.list()[0].settings, { semanticMode: "auto" });
    const migrated = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assert.equal(migrated[0].enabled, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("validates marketplace metadata from manifests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-manifest-"));
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "index.js"), "export default {};\n");
  const manifest = { id: "com.example.metadata", name: "Metadata", version: "1.0.0", apiVersion: 1, description: "Metadata plugin", entrypoint: "dist/index.js", hooks: [], repository: "https://github.com/example/metadata.git", categories: ["Security"], tags: ["privacy"], author: "Example", homepage: "https://example.com/plugin" };
  try {
    await fs.writeFile(path.join(root, "multivibe.module.json"), JSON.stringify(manifest));
    assert.deepEqual((await readModuleManifest(root)).categories, ["Security"]);
    await fs.writeFile(path.join(root, "multivibe.module.json"), JSON.stringify({ ...manifest, homepage: "javascript:alert(1)" }));
    await assert.rejects(() => readModuleManifest(root), /public HTTPS URL/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("built-in plugins expose settings while disabled and persist configuration across restarts", async () => {
  const { automaticRouterManifest, createAutomaticRouter } = await import("./automatic-router.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-builtin-"));
  try {
    const manager = new ModuleManager(root);
    manager.registerBuiltin(automaticRouterManifest, createAutomaticRouter());
    await manager.initialize();
    assert.equal(manager.list()[0].enabled, false);
    assert.ok(manager.list()[0].manifest?.settingsSchema);
    await manager.setSettings(automaticRouterManifest.id, { classifierModel: "test", sessionTtlMinutes: 5 });
    await assert.rejects(manager.setSettings(automaticRouterManifest.id, { sessionTtlMinutes: 0 }), /out of range/);
    await manager.setEnabled(automaticRouterManifest.id, true);
    assert.equal(manager.list()[0].loaded, true);
    const restarted = new ModuleManager(root);
    restarted.registerBuiltin(automaticRouterManifest, createAutomaticRouter());
    await restarted.initialize();
    assert.equal(restarted.list()[0].settings.classifierModel, "test");
    assert.equal(restarted.list()[0].loaded, true);
    await restarted.setEnabled(automaticRouterManifest.id, false);
    assert.ok(restarted.list()[0].manifest?.settingsSchema);
    await assert.rejects(restarted.update(automaticRouterManifest.id), /updates with MultiVibe/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
