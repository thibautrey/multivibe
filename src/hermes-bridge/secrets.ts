/**
 * Secret storage for the bridge.
 *
 * Preference order matches each platform's own facility:
 *   macOS  -> login Keychain via `security`
 *   Linux  -> Secret Service via `secret-tool`
 *   else   -> a 0600 file inside the bridge's private directory
 *
 * The bridge holds four values: its edge API key, an optional Cloudflare Access
 * service token pair, the client's own Nous Research key, and the random key the
 * local harness must present. All are read into memory only; none is written to
 * a log, an error, or the health endpoint.
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { BridgeSecrets } from "./config.js";

const run = promisify(execFile);

export const SECRET_SERVICE = "multivibe-hermes-bridge";

/** Canonical secret names. Fixed strings so a rename cannot silently orphan a value. */
export const SECRET_NAMES = {
  edgeApiKey: "edge-api-key",
  accessClientId: "access-client-id",
  accessClientSecret: "access-client-secret",
  nousApiKey: "nous-api-key",
  localKey: "local-bridge-key",
} as const;

export type SecretName = keyof typeof SECRET_NAMES;

/**
 * A named secret store. `read`/`write` take a canonical name rather than a
 * field, so one implementation serves both the upstream credentials and the
 * local harness key.
 */
export type SecretBackend = {
  kind: "keychain" | "secret-tool" | "file";
  read(name: SecretName): Promise<string | undefined>;
  write(name: SecretName, value: string): Promise<void>;
  remove(name: SecretName): Promise<void>;
};

/** macOS login Keychain. */
export function keychainBackend(account = process.env.USER ?? "user"): SecretBackend {
  const service = `${SECRET_SERVICE}:${account}`;
  const entry = (name: SecretName) => SECRET_NAMES[name];
  return {
    kind: "keychain",
    async read(name) {
      try {
        const { stdout } = await run("security", [
          "find-generic-password",
          "-s",
          service,
          "-a",
          entry(name),
          "-w",
        ]);
        const value = stdout.trim();
        return value.length ? value : undefined;
      } catch {
        return undefined;
      }
    },
    async write(name, value) {
      // Replace rather than duplicate an existing item.
      await run("security", ["delete-generic-password", "-s", service, "-a", entry(name)]).catch(
        () => undefined,
      );
      await run("security", ["add-generic-password", "-s", service, "-a", entry(name), "-w", value, "-U"]);
    },
    async remove(name) {
      await run("security", ["delete-generic-password", "-s", service, "-a", entry(name)]).catch(
        () => undefined,
      );
    },
  };
}

/** Linux Secret Service through libsecret. */
export function secretToolBackend(): SecretBackend {
  const attributes = (name: SecretName) => ["service", SECRET_SERVICE, "key", SECRET_NAMES[name]];
  return {
    kind: "secret-tool",
    async read(name) {
      try {
        const { stdout } = await run("secret-tool", ["lookup", ...attributes(name)]);
        const value = stdout.trim();
        return value.length ? value : undefined;
      } catch {
        return undefined;
      }
    },
    async write(name, value) {
      // The secret arrives on stdin so it never appears in the process table.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "secret-tool",
          ["store", "--label", `${SECRET_SERVICE} ${name}`, ...attributes(name)],
          { stdio: ["pipe", "ignore", "ignore"] },
        );
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error("secret-tool store failed")),
        );
        child.stdin?.end(value);
      });
    },
    async remove(name) {
      await run("secret-tool", ["clear", ...attributes(name)]).catch(() => undefined);
    },
  };
}

/** Private 0600 file, used when no system secret service is available. */
export function fileBackend(directory: string): SecretBackend {
  const file = path.join(directory, "secrets.json");
  const readAll = async (): Promise<Record<string, string>> => {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    } catch {
      return {};
    }
  };
  const writeAll = async (values: Record<string, string>) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}`;
    await fs.writeFile(temporary, JSON.stringify(values), { mode: 0o600 });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  };
  return {
    kind: "file",
    async read(name) {
      return (await readAll())[SECRET_NAMES[name]];
    },
    async write(name, value) {
      const values = await readAll();
      values[SECRET_NAMES[name]] = value;
      await writeAll(values);
    },
    async remove(name) {
      const values = await readAll();
      delete values[SECRET_NAMES[name]];
      await writeAll(values);
    },
  };
}

/**
 * Choose a backend. Never throws: a broken keychain degrades to the private
 * file so the bridge still starts, and `doctor` reports the real state.
 */
export async function resolveBackend(platform: NodeJS.Platform, directory: string): Promise<SecretBackend> {
  if (platform === "darwin") return keychainBackend();
  if (platform === "linux") {
    try {
      await run("secret-tool", ["--version"], { timeout: 3_000 });
      return secretToolBackend();
    } catch {
      return fileBackend(directory);
    }
  }
  return fileBackend(directory);
}

/** Load every stored value. Absent stays absent rather than becoming empty. */
export async function loadSecrets(backend: SecretBackend): Promise<{
  secrets: Partial<BridgeSecrets>;
  localKey?: string;
}> {
  const read = async (name: SecretName) => backend.read(name);
  const [edgeApiKey, accessClientId, accessClientSecret, nousApiKey, localKey] = await Promise.all([
    read("edgeApiKey"),
    read("accessClientId"),
    read("accessClientSecret"),
    read("nousApiKey"),
    read("localKey"),
  ]);
  return {
    secrets: {
      edgeApiKey: edgeApiKey ?? "",
      ...(accessClientId ? { accessClientId } : {}),
      ...(accessClientSecret ? { accessClientSecret } : {}),
      ...(nousApiKey ? { nousApiKey } : {}),
    },
    ...(localKey ? { localKey } : {}),
  };
}

/** Store only the values that are present, leaving the others untouched. */
export async function storeSecrets(
  backend: SecretBackend,
  values: Partial<BridgeSecrets>,
): Promise<void> {
  const names: SecretName[] = ["edgeApiKey", "accessClientId", "accessClientSecret", "nousApiKey"];
  for (const name of names) {
    const value = values[name];
    if (typeof value === "string" && value.length > 0) await backend.write(name, value);
  }
}
