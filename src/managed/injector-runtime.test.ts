import test from "node:test";
import assert from "node:assert/strict";
import { loadManagedInjectorRuntimeConfig, createManagedInjectorRuntime } from "./injector-runtime.js";
const env={MANAGED_INJECTOR_JOURNAL_DIRECTORY:"/nonexistent-injector-test-journal",MANAGED_INJECTOR_PROVIDER_MANIFEST_FILE:"/config/providers.json",
 MANAGED_INJECTOR_CREDENTIAL_DIRECTORY:"/credentials",MANAGED_INJECTOR_TLS_KEY_FILE:"/tls/key",MANAGED_INJECTOR_TLS_CERT_FILE:"/tls/cert",
 MANAGED_INJECTOR_TLS_CA_FILE:"/tls/ca",MANAGED_INJECTOR_CLOUD_VERIFY_KEY_FILE:"/config/cloud.pem",MANAGED_INJECTOR_CORE_SPIFFE_URI:"spiffe://multivibe/core"};
test("injector has separate mandatory credential, journal and workload configuration",async()=>{
 const config=loadManagedInjectorRuntimeConfig(env);
 assert.equal(config.port,1457);assert.equal(config.allowedClientUri,"spiffe://multivibe/core");
 for(const name of Object.keys(env)){
  const missing:NodeJS.ProcessEnv={...env};delete missing[name];assert.throws(()=>loadManagedInjectorRuntimeConfig(missing));
 }
 assert.throws(()=>loadManagedInjectorRuntimeConfig({...env,MANAGED_INJECTOR_CREDENTIAL_DIRECTORY:"relative"}));
 await assert.rejects(createManagedInjectorRuntime(config),/ENOENT|journal_directory_required/);
});
