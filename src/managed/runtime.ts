import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createPublicKey } from "node:crypto";
import { ExecutionJournal } from "./journal.js";
import { ManagedExecutor } from "./executor.js";
import { createManagedExecutionServer } from "./http.js";
import { ManagedInjectorClient } from "./injector-client.js";
import type { ManagedProviderAccount } from "./executor.js";

export interface ManagedRuntimeConfig {
  host: string;
  port: number;
  journalDirectory: string;
  providerManifestFile: string;
  injectorUrl: string;
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
export function loadManagedRuntimeConfig(env: NodeJS.ProcessEnv): ManagedRuntimeConfig {
  const path = (name: string) => { const value = required(env, name); if (!isAbsolute(value)) throw Error(`Invalid ${name}`); return value; };
  if (env.MANAGED_CORE_CREDENTIAL_DIRECTORY !== undefined) throw Error("Provider credentials must not be configured in Core");
  const injectorUrl=new URL(required(env,"MANAGED_CORE_INJECTOR_URL"));
  if(injectorUrl.protocol!=="https:"||injectorUrl.username||injectorUrl.password||injectorUrl.pathname!=="/"||injectorUrl.search||injectorUrl.hash) throw Error("Invalid MANAGED_CORE_INJECTOR_URL");
  return {
    host: env.MANAGED_CORE_HOST ?? "0.0.0.0",
    port: integer(env, "MANAGED_CORE_PORT", 1456, 65535),
    journalDirectory: path("MANAGED_CORE_JOURNAL_DIRECTORY"),
    providerManifestFile: path("MANAGED_CORE_PROVIDER_MANIFEST_FILE"),
    injectorUrl: required(env, "MANAGED_CORE_INJECTOR_URL"),
    tlsKeyFile: path("MANAGED_CORE_TLS_KEY_FILE"), tlsCertFile: path("MANAGED_CORE_TLS_CERT_FILE"),
    tlsCaFile: path("MANAGED_CORE_TLS_CA_FILE"), cloudVerificationKeyFile: path("MANAGED_CORE_CLOUD_VERIFY_KEY_FILE"),
    allowedClientUri: required(env, "MANAGED_CORE_CLOUD_SPIFFE_URI"),
    maximumRequestBytes: integer(env, "MANAGED_CORE_MAX_REQUEST_BYTES", 2 * 1024 * 1024, 16 * 1024 * 1024),
    maximumResponseBytes: integer(env, "MANAGED_CORE_MAX_RESPONSE_BYTES", 8 * 1024 * 1024, 64 * 1024 * 1024),
    maximumConcurrentExecutions: integer(env, "MANAGED_CORE_MAX_CONCURRENCY", 16, 1024),
    executionTimeoutMs: integer(env, "MANAGED_CORE_EXECUTION_TIMEOUT_MS", 120000, 600000),
  };
}
export async function createManagedRuntime(config: ManagedRuntimeConfig) {
  // The journal must be an existing durable volume. Never silently create an
  // ephemeral fallback directory when deployment omitted its volume mount.
  if (!(await stat(config.journalDirectory)).isDirectory()) throw Error("managed_journal_directory_required");
  const rawManifest = await readFile(config.providerManifestFile);
  if (rawManifest.byteLength > 2 * 1024 * 1024) throw Error("managed_manifest_too_large");
  const manifest = JSON.parse(rawManifest.toString("utf8"));
  if (!manifest || Object.keys(manifest).sort().join() !== "accounts,version" || manifest.version !== 1
    || !Array.isArray(manifest.accounts) || manifest.accounts.length > 100) throw Error("invalid_managed_manifest");
  const tls={key:await readFile(config.tlsKeyFile),cert:await readFile(config.tlsCertFile),ca:await readFile(config.tlsCaFile)};
  const injector=new ManagedInjectorClient(config.injectorUrl,tls,config.maximumRequestBytes,config.maximumResponseBytes,config.executionTimeoutMs);
  const refs = new Set<string>();
  const accounts: ManagedProviderAccount[] = manifest.accounts.map((account: Record<string, unknown>): ManagedProviderAccount => {
    if (!account || Object.keys(account).sort().join() !== "credentialRef,models,providerId"
      || !["mistral", "openai", "xai", "deepseek"].includes(String(account.providerId))
      || typeof account.credentialRef !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(account.credentialRef)
      || refs.has(account.credentialRef)
      || !Array.isArray(account.models) || account.models.length > 10000
      || account.models.some(id => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(id))) throw Error("invalid_managed_account");
    refs.add(account.credentialRef);
    return {providerId:account.providerId as string,credentialRef:account.credentialRef,models:new Set<string>(account.models),
      chatCompletions:(body,signal,authorization)=>injector.execute(body,signal,authorization)};
  });
  const journal = new ExecutionJournal(config.journalDirectory);
  const key = createPublicKey(await readFile(config.cloudVerificationKeyFile));
  if (key.asymmetricKeyType !== "ed25519") throw Error("invalid_cloud_verification_key");
  const executor = new ManagedExecutor({ verificationKey: key, journal, accounts,
    maximumRequestBytes: config.maximumRequestBytes, maximumResponseBytes: config.maximumResponseBytes,
    executionTimeoutMs: config.executionTimeoutMs });
  const server = createManagedExecutionServer({
    tls,
    allowedClientUri: config.allowedClientUri, executor, journal, discovery: {read:()=>injector.discovery()},
    maximumRequestBytes: config.maximumRequestBytes, maximumConcurrentExecutions: config.maximumConcurrentExecutions,
  });
  return { server, accounts };
}
