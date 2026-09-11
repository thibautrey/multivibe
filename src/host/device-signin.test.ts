import test from "node:test";
import assert from "node:assert/strict";
import { publishDeviceSignIn, takeDeviceSignIn } from "./device-signin.js";
test("device codes are transient, consumed once, and expire", () => {
  const now = Date.now();
  publishDeviceSignIn({ id: "test", provider: "openai", code: "ABCD-1234", expiresAt: now + 10000 });
  assert.equal(takeDeviceSignIn(now)?.code, "ABCD-1234");
  assert.equal(takeDeviceSignIn(now), undefined);
  publishDeviceSignIn({ id: "test", provider: "openai", code: "ABCD-1234", expiresAt: now - 1 });
  assert.equal(takeDeviceSignIn(now), undefined);
  publishDeviceSignIn({ id: "test", provider: "openai", code: "invalid\ncode", expiresAt: now + 10000 });
  assert.equal(takeDeviceSignIn(now), undefined);
});
