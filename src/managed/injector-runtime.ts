import { readFile, stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { createPublicKey } from "node:crypto";
import { ManagedDiscovery } from "./discovery.js";
import { ExecutionJournal } from "./journal.js";
import { ManagedCredentialInjector } from "./injector.js";
import { createManagedInjectorServer } from "./injector-http.js";
import { createManagedProviderAccount, type ManagedCompatibleProvider } from "./provider.js";
import { createProviderProxyFetch } from "./provider-proxy-fetch.js";

export interface ManagedInjectorRuntimeConfig {
  host: string;
  port: number;
  journalDirectory: string;
  providerManifestFile: string;
  providerCredentialDirectory: string;
  tlsKeyFile: string;
  tlsCertFile: string;
  tlsCaFile: string;
  cloudVerificationKeyFile: string;
  allowedClientUri: string;
  maximumRequestBytes: number;
  maximumResponseBytes: number;
  maximumConcurrentExecutions: number;
  executionTimeoutMs: number;
}
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw Error(`Missing ${name}`);
  return value.trim();
}
function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, maximum: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw Error(`Invalid ${name}`);
  return value;
}
export function loadManagedInjectorRuntimeConfig(env: NodeJS.ProcessEnv): ManagedInjectorRuntimeConfig {
  const path = (name: string) => { const value = required(env, name); if (!isAbsolute(value)) throw Error(`Invalid ${name}`); return value; };
  return {
    host: env.MANAGED_INJECTOR_HOST ?? "0.0.0.0",
    port: integer(env, "MANAGED_INJECTOR_PORT", 1457, 65535),
    journalDirectory: path("MANAGED_INJECTOR_JOURNAL_DIRECTORY"),
    providerManifestFile: path("MANAGED_INJECTOR_PROVIDER_MANIFEST_FILE"),
    providerCredentialDirectory: path("MANAGED_INJECTOR_CREDENTIAL_DIRECTORY"),
    tlsKeyFile: path("MANAGED_INJECTOR_TLS_KEY_FILE"), tlsCertFile: path("MANAGED_INJECTOR_TLS_CERT_FILE"),
    tlsCaFile: path("MANAGED_INJECTOR_TLS_CA_FILE"), cloudVerificationKeyFile: path("MANAGED_INJECTOR_CLOUD_VERIFY_KEY_FILE"),
    allowedClientUri: required(env, "MANAGED_INJECTOR_CORE_SPIFFE_URI"),
    maximumRequestBytes: integer(env, "MANAGED_INJECTOR_MAX_REQUEST_BYTES", 2 * 1024 * 1024, 16 * 1024 * 1024),
    maximumResponseBytes: integer(env, "MANAGED_INJECTOR_MAX_RESPONSE_BYTES", 8 * 1024 * 1024, 64 * 1024 * 1024),
    maximumConcurrentExecutions: integer(env, "MANAGED_INJECTOR_MAX_CONCURRENCY", 16, 1024),
    executionTimeoutMs: integer(env, "MANAGED_INJECTOR_EXECUTION_TIMEOUT_MS", 120000, 600000),
  };
}
export async function createManagedInjectorRuntime(config: ManagedInjectorRuntimeConfig) {
  // The journal must be an existing durable volume. Never silently create an
  // ephemeral fallback directory when deployment omitted its volume mount.
  if (!(await stat(config.journalDirectory)).isDirectory()) throw Error("managed_journal_directory_required");
  const rawManifest = await readFile(config.providerManifestFile);
  if (rawManifest.byteLength > 2 * 1024 * 1024) throw Error("managed_manifest_too_large");
  const manifest = JSON.parse(rawManifest.toString("utf8"));
  if (!manifest || Object.keys(manifest).sort().join() !== "accounts,version" || manifest.version !== 1
    || !Array.isArray(manifest.accounts) || manifest.accounts.length > 100) throw Error("invalid_managed_manifest");
  const fetchViaEgress = createProviderProxyFetch();
  const refs = new Set<string>();
  const accounts = manifest.accounts.map((account: Record<string, unknown>) => {
    if (!account || Object.keys(account).sort().join() !== "credentialFile,credentialRef,models,providerId"
      || !["mistral", "openai", "xai", "deepseek"].includes(String(account.providerId))
      || typeof account.credentialRef !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(account.credentialRef)
      || refs.has(account.credentialRef) || typeof account.credentialFile !== "string"
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(account.credentialFile)
      || !Array.isArray(account.models) || account.models.length > 10000
      || account.models.some(id => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(id))) throw Error("invalid_managed_account");
    refs.add(account.credentialRef);
    const filename = resolve(config.providerCredentialDirectory, account.credentialFile);
    return createManagedProviderAccount({ providerId: account.providerId as ManagedCompatibleProvider,
      credentialRef: account.credentialRef, models: new Set<string>(account.models), fetchViaEgress,
      readCredential: async () => {
        const credential = await readFile(filename);
        if (credential.byteLength > 16384) throw Error("managed_credential_too_large");
        return credential.toString("utf8").trim();
      },
    });
  });
  const journal = new ExecutionJournal(config.journalDirectory);
  const key = createPublicKey(await readFile(config.cloudVerificationKeyFile));
  if (key.asymmetricKeyType !== "ed25519") throw Error("invalid_cloud_verification_key");
  const injector = new ManagedCredentialInjector({ verificationKey: key, journal, accounts,
    maximumRequestBytes: config.maximumRequestBytes,
    executionTimeoutMs: config.executionTimeoutMs });
  const server = createManagedInjectorServer({
    tls: { key: await readFile(config.tlsKeyFile), cert: await readFile(config.tlsCertFile), ca: await readFile(config.tlsCaFile) },
    allowedCoreUri: config.allowedClientUri, injector, discovery: new ManagedDiscovery(accounts),
    maximumRequestBytes: config.maximumRequestBytes, maximumResponseBytes: config.maximumResponseBytes, maximumConcurrentExecutions: config.maximumConcurrentExecutions,
  });
  return { server, accounts };
}
