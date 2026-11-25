import assert from "node:assert/strict";
import test from "node:test";
import {
  HEADROOM_DEFAULT_IMAGE,
  HEADROOM_DEFAULT_SETTINGS,
  HEADROOM_MODES,
  headroomPluginManifest,
  headroomSettings,
  publicHeadroomSettings,
} from "./headroom-plugin.js";

test("the bundled manifest is installable, hook-free and disabled by default", () => {
  assert.equal(headroomPluginManifest.id, "multivibe.headroom");
  assert.equal(headroomPluginManifest.defaultEnabled, false);
  assert.deepEqual(headroomPluginManifest.hooks, []);
  assert.equal(headroomPluginManifest.settingsSchema!.additionalProperties, false);
  assert.equal(HEADROOM_DEFAULT_SETTINGS.manageContainer, true);
  assert.equal(HEADROOM_DEFAULT_SETTINGS.image, HEADROOM_DEFAULT_IMAGE);
});

test("CCR is not offered because MultiVibe never redeems retrieval markers", () => {
  const properties = headroomPluginManifest.settingsSchema!.properties as Record<string, { enum?: string[] }>;
  assert.deepEqual(properties.mode.enum, [...HEADROOM_MODES]);
  assert.equal(HEADROOM_MODES.includes("ccr" as never), false);
  // Secrets never belong in module settings: the admin API echoes them.
  assert.equal("proxyToken" in properties, false);
});

test("settings are clamped to the supported contract and defaulted", () => {
  assert.deepEqual(headroomSettings(undefined), HEADROOM_DEFAULT_SETTINGS);
  const parsed = headroomSettings({
    manageContainer: "yes",
    serverUrl: "  http://headroom:8787  ",
    mode: "ccr",
    timeoutMs: 1,
    minBytes: 99_999_999,
    image: "  ",
  });
  assert.equal(parsed.manageContainer, true);
  assert.equal(parsed.serverUrl, "http://headroom:8787");
  assert.equal(parsed.mode, "");
  assert.equal(parsed.timeoutMs, 50);
  assert.equal(parsed.minBytes, 1_048_576);
  assert.equal(parsed.image, HEADROOM_DEFAULT_IMAGE);

  const high = headroomSettings({ timeoutMs: 999_999, minBytes: -10 });
  assert.equal(high.timeoutMs, 30_000);
  assert.equal(high.minBytes, 0);
  assert.equal(headroomSettings({ mode: "lossless_then_lossy" }).mode, "lossless_then_lossy");
  assert.equal(headroomSettings({ manageContainer: false }).manageContainer, false);
});

test("the public settings expose only whether a proxy token exists", () => {
  const publicSettings = publicHeadroomSettings(HEADROOM_DEFAULT_SETTINGS, true);
  assert.equal(publicSettings.hasProxyToken, true);
  assert.equal(publicHeadroomSettings(HEADROOM_DEFAULT_SETTINGS, false).hasProxyToken, false);
  assert.deepEqual(Object.keys(publicSettings).sort(), ["hasProxyToken", "image", "manageContainer", "minBytes", "mode", "serverUrl", "timeoutMs"]);
});
