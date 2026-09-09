import test from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("native quota rotation follows activity, debounces, pins, and handles removal", { skip: process.platform !== "darwin" }, () => {
  const source = readFileSync(new URL("../../packaging/macos/MultiVibeMenuBar.swift", import.meta.url), "utf8");
  const start = source.indexOf("private struct ProviderActivity:");
  const end = source.indexOf("private struct MenuBarGitHubStarPrompt", start);
  const dir = mkdtempSync(join(tmpdir(), "multivibe-quota-test-"));
  try {
    const file = join(dir, "main.swift");
    writeFileSync(file, "import Foundation\n" + source.slice(start, end) + `
func check(_ condition: Bool, _ message: String) { precondition(condition, message) }
private var rotation = QuotaRotation()
let ids = ["openai", "zai", "opencode"]
rotation.update(ids: ids, activity: nil, now: 100)
check(rotation.selected == "openai", "initial provider")
rotation.update(ids: ids, activity: nil, now: 111)
check(rotation.selected == "openai", "no early rotation")
rotation.update(ids: ids, activity: nil, now: 112)
check(rotation.selected == "zai", "12 second rotation")
rotation.update(ids: ids, activity: ProviderActivity(providerId: "opencode", usedAt: 113000), now: 113)
check(rotation.selected == "zai", "concurrent traffic debounce")
rotation.update(ids: ids, activity: nil, now: 117)
check(rotation.selected == "opencode", "pending activity wins after debounce")
rotation.update(ids: ids, activity: nil, now: 146)
check(rotation.selected == "opencode", "30 second activity hold")
rotation.update(ids: ids, activity: nil, now: 147)
check(rotation.selected == "openai", "rotation resumes")
rotation.pin = "zai"
rotation.update(ids: ids, activity: ProviderActivity(providerId: "openai", usedAt: 148000), now: 148)
check(rotation.selected == "zai", "pin overrides usage")
rotation.update(ids: ids, activity: nil, now: 300)
check(rotation.selected == "zai", "pin overrides timer")
rotation.update(ids: ["opencode"], activity: nil, now: 301)
check(rotation.selected == "opencode", "removed pin falls back")
rotation.update(ids: [], activity: nil, now: 302)
check(rotation.selected == nil, "empty inventory")
rotation.pin = nil
rotation.update(ids: ids, activity: ProviderActivity(providerId: "zai", usedAt: 400000), now: 400)
check(rotation.selected == "zai", "initial fresh activity wins")
rotation.update(ids: ids, activity: ProviderActivity(providerId: "openai", usedAt: 401000), now: 440)
check(rotation.selected == "opencode", "stale activity cannot hijack idle rotation")
`);
    execFileSync("swift", [file], { stdio: "pipe", timeout: 60000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
