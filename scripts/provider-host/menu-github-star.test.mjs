import test from "node:test";
import { readMacOSMenuSourceSync } from "./macos-menu-sources.mjs";
import assert from "node:assert/strict";

const source = readMacOSMenuSourceSync();

test("GitHub invitation persists its acknowledgement on presentation, not only on action", () => {
  const start = source.indexOf("func presentNextNotificationIfNeeded()");
  const end = source.indexOf("func performNotificationAction", start);
  const presentation = source.slice(start, end);
  assert.match(presentation, /if next\.kind == "github-star" \{[^}]*githubStarPromptAcknowledged = true[^}]*UserDefaults\.standard\.set\(true, forKey: Self\.githubStarPromptAcknowledgedKey\)/s);
  assert.ok(presentation.indexOf("pendingNotifications.removeFirst()") < presentation.indexOf("githubStarPromptAcknowledged = true"));
});

test("relaunch restores acknowledgement and suppresses an already shown GitHub invitation", () => {
  assert.match(source, /var githubStarPromptAcknowledged = UserDefaults\.standard\.bool\(forKey: githubStarPromptAcknowledgedKey\)/);
  assert.match(source, /let shouldPreferGitHub = summary\.githubStarPrompt\?\.eligible == true\s*&& !githubStarPromptAcknowledged\s*&& !githubStarPromptPresented/);
  assert.match(source, /if shouldPreferGitHub \{\s*enqueue\(MenuBarNotification\(/);
});
