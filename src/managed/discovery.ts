import { createHash } from "node:crypto";
import type { ManagedProviderAccount } from "./executor.js";
export interface ManagedDiscoveryAccount extends ManagedProviderAccount {
  discoverModels(signal: AbortSignal): Promise<readonly string[]>;
}
/** Sanitized execution-path evidence. Neither credentials nor upstream error bodies
 * leave Core; configured execution models remain distinct from discovered models. */
export class ManagedDiscovery {
  private active: Promise<unknown> | undefined;
  private cached: { expiresAt: number; value: unknown } | undefined;
  constructor(private readonly accounts: readonly ManagedDiscoveryAccount[], private readonly clock = Date.now) {}
  async read(): Promise<unknown> {
    const now = this.clock();
    if (this.cached && this.cached.expiresAt > now) return this.cached.value;
    if (this.active) return this.active;
    this.active = this.collect().then(value => {
      this.cached = { expiresAt: this.clock() + 30000, value };
      return value;
    }).finally(() => { this.active = undefined; });
    return this.active;
  }
  private async collect() {
    const observedAt = this.clock();
    const items = [];
    // Bound concurrency and provider quota use; each account has its own deadline.
    for (const account of this.accounts) {
      try {
        const models = await account.discoverModels(AbortSignal.timeout(10000));
        items.push({ providerId: account.providerId, credentialRef: account.credentialRef,
          status: "verified", models, executableModels: [...account.models].filter(id => models.includes(id)).sort() });
      } catch {
        items.push({ providerId: account.providerId, credentialRef: account.credentialRef,
          status: "unavailable", models: [], executableModels: [] });
      }
    }
    const evidence = { version: 1, path: "managed-core-provider-egress", observedAt, completedAt: this.clock(), accounts: items };
    return { ...evidence, digest: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") };
  }
}
