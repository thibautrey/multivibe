import type { KeyObject } from "node:crypto";
import type { ManagedProviderAccount, ManagedInvocationAuthorization } from "./executor.js";
import { authorizeManagedInjection } from "./injector-authorization.js";
import {validateExecutionOwnership, type ExecutionOwnership} from "./coordination-client.js";

/** Lives only in the credential injector process, with its own durable journal.
 * No caller-supplied URL, credential, headers, retry policy or account fallback. */
export class ManagedCredentialInjector {
  private readonly accounts: readonly ManagedProviderAccount[];
  constructor(private readonly dependencies: {
    verificationKey: KeyObject;
    coordination: {dispatch(token: string, ownership: ExecutionOwnership): Promise<void>};
    accounts: readonly ManagedProviderAccount[];
    maximumRequestBytes: number;
    executionTimeoutMs: number;
    clock?: () => number;
  }) {
    if (!Number.isSafeInteger(dependencies.maximumRequestBytes) || dependencies.maximumRequestBytes < 1
      || !Number.isSafeInteger(dependencies.executionTimeoutMs) || dependencies.executionTimeoutMs < 1) {
      throw Error("invalid_injector_limit");
    }
    this.accounts = dependencies.accounts.map(account => ({providerId:account.providerId,
      credentialRef:account.credentialRef,models:new Set(account.models),
      chatCompletions:account.chatCompletions.bind(account)}));
  }
  async execute(providerBody: Uint8Array, authorization: ManagedInvocationAuthorization): Promise<Response> {
    // Copy before the first await: mutations in an in-process caller cannot change
    // the bytes after verification while the durable claim is being persisted.
    const body = new Uint8Array(providerBody);
    const originalBody = new Uint8Array(authorization.originalBody);
    const token = authorization.token;
    const ownership = validateExecutionOwnership(authorization.ownership);
    const clock = this.dependencies.clock ?? Date.now;
    const verify = () => authorizeManagedInjection({token,originalBody,providerBody:body,
      verificationKey:this.dependencies.verificationKey,now:clock(),maximumRequestBytes:this.dependencies.maximumRequestBytes});
    const grant = verify();
    const accounts = this.accounts.filter(account => account.providerId === grant.providerId
      && account.credentialRef === grant.credentialRef && account.models.has(grant.upstreamModel));
    if (accounts.length !== 1) throw Error("injector_account_unavailable");
    let dispatched = false;
    try {
      const response = await accounts[0].chatCompletions(body,AbortSignal.timeout(this.dependencies.executionTimeoutMs),{
        token, originalBody, ownership,
        beforeDispatch: async () => {
          if (dispatched) throw Error("injector_multiple_dispatch_attempts");
          dispatched = true;
          // The shared database checks its own clock and atomically consumes the
          // exact owner epoch. A lost response must remain ambiguous.
          verify();
          await this.dependencies.coordination.dispatch(token, ownership);
        },
      });
      if (!dispatched) {
        await response.body?.cancel().catch(() => undefined);
        throw Error("injector_dispatch_fence_not_consumed");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return Response.json({error:{code:"provider_execution_failed"}},{status:502});
      }
      // Do not forward provider diagnostic/account headers into Core.
      return new Response(response.body,{status:response.status,
        headers:{"content-type":response.headers.get("content-type") ?? "application/octet-stream"}});
    } catch {
      // The shared dispatch transition remains consumed if outcome is unknown.
      throw Error("injector_execution_uncertain");
    }
  }
}
