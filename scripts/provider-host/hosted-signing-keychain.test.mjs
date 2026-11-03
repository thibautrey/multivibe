import test from "node:test";
import assert from "node:assert/strict";
import { registerHostedSigningKeychain } from "./hosted-signing-keychain.mjs";

test("shared runners never read or change the search list", () => {
  for (const environment of [undefined, "self-hosted", ""]) {
    assert.equal(registerHostedSigningKeychain("/job/signing.keychain-db", {
      environment, run: () => { throw new Error("must not access shared preferences"); },
    }), false);
  }
});

test("hosted runner preserves every existing keychain and adds only the job keychain", () => {
  const calls = [];
  const existing = ["/user/login.keychain-db", "/user/with space.keychain-db"];
  const keychain = "/job/release signing.keychain-db";
  registerHostedSigningKeychain(keychain, { environment: "github-hosted", run: (args) => {
    calls.push(args); return existing.map((p) => `    ${JSON.stringify(p)}`).join("\n");
  } });
  assert.deepEqual(calls, [["list-keychains", "-d", "user"], ["list-keychains", "-d", "user", "-s", ...existing, keychain]]);
});

test("hosted registration is idempotent and fails closed for malformed search lists", () => {
  const keychain = "/job/release.keychain-db";
  const calls = [];
  registerHostedSigningKeychain(keychain, { environment: "github-hosted", run: (args) => {
    calls.push(args); return JSON.stringify(keychain);
  } });
  assert.equal(calls.length, 1);
  assert.throws(() => registerHostedSigningKeychain(keychain, { environment: "github-hosted", run: () => "not a quoted path" }));
});
