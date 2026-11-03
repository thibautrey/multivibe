import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Hosted runners are disposable. Shared desktop runners must never have
// their search list changed by release packaging.
export function registerHostedSigningKeychain(keychain, {
  environment = process.env.RUNNER_ENVIRONMENT,
  run = (args) => execFileSync("security", args, { encoding: "utf8" }),
} = {}) {
  if (environment !== "github-hosted") return false;
  if (!keychain || !path.isAbsolute(keychain)) throw new Error("An absolute job keychain path is required");
  const lines = run(["list-keychains", "-d", "user"]).trim().split("\n").filter((line) => line.trim());
  const existing = lines.map((line) => JSON.parse(line.trim()));
  if (existing.some((entry) => typeof entry !== "string" || !path.isAbsolute(entry))) {
    throw new Error("Unexpected keychain search list");
  }
  if (!existing.includes(keychain)) run(["list-keychains", "-d", "user", "-s", ...existing, keychain]);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  registerHostedSigningKeychain(process.env.SIGNING_KEYCHAIN);
}
