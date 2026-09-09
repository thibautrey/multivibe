import test from "node:test";
import assert from "node:assert/strict";
import { loadManagedRuntimeConfig } from "./runtime.js";
function environment(): NodeJS.ProcessEnv {
  return { MANAGED_CORE_JOURNAL_DIRECTORY: "/journal", MANAGED_CORE_PROVIDER_MANIFEST_FILE: "/config/accounts.json",
    MANAGED_CORE_CREDENTIAL_DIRECTORY: "/credentials", MANAGED_CORE_TLS_KEY_FILE: "/tls/key",
    MANAGED_CORE_TLS_CERT_FILE: "/tls/cert", MANAGED_CORE_TLS_CA_FILE: "/tls/ca",
    MANAGED_CORE_CLOUD_VERIFY_KEY_FILE: "/config/verify-key", MANAGED_CORE_CLOUD_SPIFFE_URI: "spiffe://multivibe/cloud-api" };
}
test("managed runtime has explicit required credentials, TLS and durable journal configuration", () => {
  const env = environment();
  const config = loadManagedRuntimeConfig(env);
  assert.equal(config.port, 1456);
  assert.equal(config.maximumConcurrentExecutions, 16);
  for (const name of Object.keys(env)) {
    const missing = { ...env }; delete missing[name];
    assert.throws(() => loadManagedRuntimeConfig(missing));
  }
  assert.throws(() => loadManagedRuntimeConfig({ ...env, MANAGED_CORE_JOURNAL_DIRECTORY: "relative" }));
  assert.throws(() => loadManagedRuntimeConfig({ ...env, MANAGED_CORE_EXECUTION_TIMEOUT_MS: "Infinity" }));
  assert.throws(() => loadManagedRuntimeConfig({ ...env, MANAGED_CORE_MAX_CONCURRENCY: "0" }));
});
