import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("source archive is deterministic and bound to the tag", () => {
  const root = mkdtempSync(join(tmpdir(), "multivibe-source-release-"));
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tag = "source-v0.0.0-test";
  execFileSync("git", ["tag", tag, sha]);
  try {
    for (const dir of ["a", "b"]) execFileSync(process.execPath, ["scripts/build-source-release.mjs", tag, sha, join(root, dir)]);
    assert.equal(readFileSync(join(root, "a/SHA256SUMS"), "utf8"), readFileSync(join(root, "b/SHA256SUMS"), "utf8"));
    const names = execFileSync("tar", ["-tzf", join(root, "a", `multivibe-${tag}-source.tar.gz`)], { encoding: "utf8" });
    assert.match(names, new RegExp(`multivibe-${tag}/LICENSE`));
    assert.match(names, new RegExp(`multivibe-${tag}/NOTICE`));
    const notice = execFileSync("git", ["show", `${sha}:NOTICE`], { encoding: "utf8" });
    assert.doesNotMatch(notice, /\bTHIRD_PARTY\b/, "NOTICE must not claim a nonexistent inventory");
    const claimedPaths = [...notice.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const bundleLicense = "ChromiumEmbeddedFramework-LICENSE.txt";
    const repositoryPaths = ["LICENSE", "native/ios/MultiVibeChat/Resources/Assets.xcassets"];
    assert.deepEqual(claimedPaths, [repositoryPaths[0], bundleLicense, repositoryPaths[1]],
      "every NOTICE path claim must be explicit and reviewed");
    const archived = new Set(names.trim().split("\n"));
    for (const claimedPath of repositoryPaths) {
      const entry = `multivibe-${tag}/${claimedPath}`;
      assert.ok(archived.has(entry) || archived.has(`${entry}/`), `NOTICE repository path claim is absent: ${claimedPath}`);
    }
    // This notice explicitly describes an installed app resource, rather
    // than a source file. Verify both its packaging and verification gates.
    for (const script of ["cef-runtime.mjs", "verify-provider-host.mjs"]) {
      const source = execFileSync("git", ["show", `${sha}:scripts/provider-host/${script}`], { encoding: "utf8" });
      assert.ok(source.includes(bundleLicense), `bundle license is missing from ${script}`);
    }
  } finally { execFileSync("git", ["tag", "-d", tag]); }
});
