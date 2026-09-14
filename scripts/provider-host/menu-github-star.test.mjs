import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../packaging/macos/MultiVibeMenuBar.swift", import.meta.url), "utf8");

test("GitHub invitation persists its acknowledgement on presentation, not only on action", () => {
  const start = source.indexOf("private func presentNextNotificationIfNeeded()");
  const end = source.indexOf("private func performNotificationAction", start);
  const presentation = source.slice(start, end);
  assert.match(presentation, /if next\.kind == "github-star" \{[^}]*githubStarPromptAcknowledged = true[^}]*UserDefaults\.standard\.set\(true, forKey: Self\.githubStarPromptAcknowledgedKey\)/s);
  assert.ok(presentation.indexOf("pendingNotifications.removeFirst()") < presentation.indexOf("githubStarPromptAcknowledged = true"));
});

test("relaunch restores acknowledgement and suppresses an already shown GitHub invitation", () => {
  assert.match(source, /private var githubStarPromptAcknowledged = UserDefaults\.standard\.bool\(forKey: githubStarPromptAcknowledgedKey\)/);
  assert.match(source, /let shouldPreferGitHub = summary\.githubStarPrompt\?\.eligible == true\s*&& !githubStarPromptAcknowledged\s*&& !githubStarPromptPresented/);
  assert.match(source, /if shouldPreferGitHub \{\s*enqueue\(MenuBarNotification\(/);
});
