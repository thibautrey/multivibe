import type { Account } from "../types";

export function tracksSubscriptionQuota(
  account: Pick<Account, "localRuntime" | "multivibeCloud">,
): boolean {
  return account.localRuntime === undefined && account.multivibeCloud !== true;
}
