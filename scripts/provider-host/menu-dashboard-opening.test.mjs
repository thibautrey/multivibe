import assert from "node:assert/strict";
import test from "node:test";
import { readMacOSMenuSourceSync } from "./macos-menu-sources.mjs";

const source = readMacOSMenuSourceSync();

test("macOS menu bar retries dashboard sessions on the canonical edge port", () => {
  assert.match(source, /let canonicalURL = URL\(string: "http:\/\/127\.0\.0\.1:\\\(configuredHostPort\)"\)!/);
  assert.match(source, /if dashboardURL != canonicalURL \{ candidates\.append\(canonicalURL\) \}/);
  assert.match(source, /self\.requestDashboardSession\(using: Array\(candidates\.dropFirst\(\)\)\)/);
});

test("macOS menu bar closes only after the dashboard URL opens", () => {
  const handler = source.slice(source.indexOf("popoverController.openDashboard ="), source.indexOf("popoverController.configureWorker ="));
  assert.doesNotMatch(handler, /performClose/);
  assert.match(source, /if NSWorkspace\.shared\.open\(dashboard\) \{\s*self\.popover\.performClose\(nil\)/);
});
