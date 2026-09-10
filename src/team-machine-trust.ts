import { createPublicKey } from "node:crypto";

// Public trust anchor only. The dedicated private signer stays in Cloud.
export const productionTeamMachineKeys: Readonly<Record<string, string>> = Object.freeze({
  "team-machine-20260910": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAkP4bH6wIVSr+8u1VdVs92PPDofig3+IVWw4lCPLrG1c=\n-----END PUBLIC KEY-----\n"
});

/** An explicit override replaces the production anchors for self-hosted deployments. */
export function teamMachineTrustedKeys(override?: string): Record<string, string> {
  if (override === undefined) return { ...productionTeamMachineKeys };
  const keys: unknown = JSON.parse(override);
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw new Error("Invalid Team trust anchors");
  for (const [id, pem] of Object.entries(keys)) {
    if (!id || typeof pem !== "string" || createPublicKey(pem).asymmetricKeyType !== "ed25519") {
      throw new Error("Invalid Team trust anchor");
    }
  }
  return keys as Record<string, string>;
}
