/** This policy is deployment-owned. Cloud-authorized execution still requires
 * the exact signed grant, account match and durable dispatch fence at both hops. */
export type ManagedModelPolicy = "allowlist" | "cloud_authorized";
export function parseManagedModelPolicy(value: unknown): ManagedModelPolicy {
  if(value===undefined)return "allowlist";
  if(value!=="allowlist"&&value!=="cloud_authorized")throw Error("invalid_managed_model_policy");
  return value;
}
export function managedModelAllowed(account:{models:ReadonlySet<string>;modelPolicy?:ManagedModelPolicy},model:unknown):boolean {
  return typeof model==="string"&&/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(model)
    && (account.modelPolicy==="cloud_authorized"||account.models.has(model));
}
