import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { productionTeamMachineKeys, teamMachineTrustedKeys } from "./team-machine-trust.js";

test("production anchor is Ed25519 and callers cannot mutate the default", () => {
  const keys = teamMachineTrustedKeys();
  assert.equal(createPublicKey(keys["team-machine-20260910"]).asymmetricKeyType, "ed25519");
  delete keys["team-machine-20260910"];
  assert.deepEqual(teamMachineTrustedKeys(), productionTeamMachineKeys);
});
test("self-hosted anchors replace defaults, including explicit empty trust", () => {
  const key = generateKeyPairSync("ed25519").publicKey.export({type:"spki",format:"pem"});
  assert.deepEqual(teamMachineTrustedKeys(JSON.stringify({company:key})), {company:key});
  assert.deepEqual(teamMachineTrustedKeys("{}"), {});
});
test("invalid trust configuration fails closed", () => {
  for (const value of ["null", "[]", "true", '{"key":42}', '{"key":"invalid"}']) {
    assert.throws(() => teamMachineTrustedKeys(value));
  }
});
