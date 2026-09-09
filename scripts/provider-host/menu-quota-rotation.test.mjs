import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("native menu bar sizes the status item to its visible quota", () => {
  const source = readFileSync(new URL("../../packaging/macos/MultiVibeMenuBar.swift", import.meta.url), "utf8");
  const start = source.indexOf("private func renderQuota()");
  const end = source.indexOf("private func render()", start);
  const renderQuota = source.slice(start, end);

  assert.match(renderQuota, /statusItem\.length = NSStatusItem\.variableLength/u);
  assert.doesNotMatch(renderQuota, /Reserve the widest|statusItem\.length = width/u);
});

test("reset-credit increases use a brief unthrottled menu-bar popup", () => {
  const source = readFileSync(new URL("../../packaging/macos/MultiVibeMenuBar.swift", import.meta.url), "utf8");
  assert.match(source, /next\.kind == "reset-credit-increased"/);
  assert.match(source, /closeNotification\(after: next\.kind == "reset-credit-increased" \? 5 : 8\)/);
});

test("native quota selection changes only for activity, pins, and removal", { skip: process.platform !== "darwin" }, () => {
  const source = readFileSync(new URL("../../packaging/macos/MultiVibeMenuBar.swift", import.meta.url), "utf8");
  const start = source.indexOf("private struct ProviderActivity:");
  const end = source.indexOf("private struct MenuBarGitHubStarPrompt", start);
  const dir = mkdtempSync(join(tmpdir(), "multivibe-quota-test-"));
  try {
    const file = join(dir, "main.swift");
    writeFileSync(file, "import Foundation\n" + source.slice(start, end) + `
func check(_ condition: Bool, _ message: String) { precondition(condition, message) }
private var selection = QuotaSelection()
let ids = ["openai", "zai", "opencode"]
selection.update(ids: ids, activity: nil, now: 100)
check(selection.selected == "openai", "initial provider")
selection.update(ids: ids, activity: nil, now: 111)
check(selection.selected == "openai", "idle selection stays stable")
selection.update(ids: ids, activity: nil, now: 112)
check(selection.selected == "openai", "elapsed time alone does not rotate")
selection.update(ids: ids, activity: ProviderActivity(providerId: "opencode", usedAt: 113000), now: 113)
check(selection.selected == "opencode", "fresh activity changes an idle selection")
selection.update(ids: ids, activity: ProviderActivity(providerId: "zai", usedAt: 114000), now: 114)
check(selection.selected == "opencode", "concurrent traffic debounce")
selection.update(ids: ids, activity: nil, now: 117)
check(selection.selected == "opencode", "no early concurrent activity change")
selection.update(ids: ids, activity: nil, now: 118)
check(selection.selected == "zai", "pending activity wins after debounce")
selection.update(ids: ids, activity: nil, now: 300)
check(selection.selected == "zai", "idle selection remains on the last informative provider")
selection.pin = "zai"
selection.update(ids: ids, activity: ProviderActivity(providerId: "openai", usedAt: 301000), now: 301)
check(selection.selected == "zai", "pin overrides usage")
selection.update(ids: ids, activity: nil, now: 500)
check(selection.selected == "zai", "pin stays stable while idle")
selection.update(ids: ["opencode"], activity: nil, now: 501)
check(selection.selected == "opencode", "removed pin falls back")
selection.update(ids: [], activity: nil, now: 502)
check(selection.selected == nil, "empty inventory")
selection.pin = nil
selection.update(ids: ids, activity: ProviderActivity(providerId: "zai", usedAt: 600000), now: 600)
check(selection.selected == "zai", "initial fresh activity wins")
selection.update(ids: ids, activity: ProviderActivity(providerId: "openai", usedAt: 601000), now: 640)
check(selection.selected == "zai", "stale activity cannot hijack the stable selection")
`);
    execFileSync("swift", [file], { stdio: "pipe", timeout: 60000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
