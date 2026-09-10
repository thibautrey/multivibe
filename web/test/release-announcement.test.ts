import assert from "node:assert/strict";
import test from "node:test";
import {
  compareVersions,
  dismissReleaseAnnouncement,
  extractReleaseBanner,
  fetchGitHubReleaseNotes,
  readReleaseAnnouncement,
} from "../src/release-announcement";

function storage(entries: Record<string, string> = {}) {
  return {
    getItem: (key: string) => entries[key] ?? null,
    setItem: (key: string, value: string) => { entries[key] = value; },
    removeItem: (key: string) => { delete entries[key]; },
    entries,
  };
}

test("compares stable and prerelease versions", () => {
  assert.equal(compareVersions("0.2.10", "0.2.9"), 1);
  assert.equal(compareVersions("v1.2", "1.2.0"), 0);
  assert.equal(compareVersions("1.2.0", "1.2.0-rc.2"), 1);
  assert.equal(compareVersions("1.2.0-rc.10", "1.2.0-rc.2"), 1);
  assert.equal(compareVersions("not-a-version", "1.0.0"), null);
});

test("announces only a newer version and keeps it pending until dismissal", () => {
  const store = storage();
  assert.equal(readReleaseAnnouncement(store, "0.2.60"), null);
  assert.equal(readReleaseAnnouncement(store, "0.2.61"), "0.2.61");
  assert.equal(readReleaseAnnouncement(store, "0.2.61"), "0.2.61");
  dismissReleaseAnnouncement(store, "0.2.61");
  assert.equal(readReleaseAnnouncement(store, "0.2.61"), null);
  assert.equal(readReleaseAnnouncement(store, "0.2.60"), null);
});

test("uses a confirmed native installation when no browser baseline exists", () => {
  const updatedStore = storage();
  assert.equal(readReleaseAnnouncement(updatedStore, "0.2.61", "2026-09-10T10:00:00Z"), "0.2.61");

  const firstInstallStore = storage();
  assert.equal(readReleaseAnnouncement(firstInstallStore, "0.2.61"), null);
});

test("uses the first trusted GitHub-hosted Markdown image as the banner", () => {
  const markdown = "Welcome!\n\n![MultiVibe v1.2](https://raw.githubusercontent.com/thibautrey/multivibe/main/docs/images/release-1.2.png)\n\n## Improvements\n- Faster startup";
  assert.deepEqual(extractReleaseBanner(markdown), {
    bannerUrl: "https://raw.githubusercontent.com/thibautrey/multivibe/main/docs/images/release-1.2.png",
    bannerAlt: "MultiVibe v1.2",
    body: "Welcome!\n\n\n\n## Improvements\n- Faster startup",
  });
  assert.equal(extractReleaseBanner("![Nope](https://example.com/banner.png)").bannerUrl, null);
});

test("loads the matching GitHub release and separates its banner", async () => {
  const calls: string[] = [];
  const release = await fetchGitHubReleaseNotes("1.2.0", (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({
      name: "MultiVibe Host 1.2.0",
      body: "![Banner](https://github.com/user-attachments/assets/abc)\n\nEverything is faster.",
      html_url: "https://github.com/thibautrey/multivibe/releases/tag/v1.2.0",
      published_at: "2026-09-10T10:00:00Z",
    }), { status: 200 });
  }) as typeof fetch);
  assert.deepEqual(calls, ["https://api.github.com/repos/thibautrey/multivibe/releases/tags/v1.2.0"]);
  assert.equal(release.bannerUrl, "https://github.com/user-attachments/assets/abc");
  assert.equal(release.body, "Everything is faster.");
  assert.equal(release.title, "MultiVibe Host 1.2.0");
});
