import type { KeyObject } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { verifyExecutionGrant, type ExecutionGrant } from "./authorization.js";
import { managedProviderRequest } from "./request.js";

/** Run in the separate injector, before reading a credential or dispatching.
 * Recompute with Core's pure converter, rather than trusting Core's transformed body.
 * This is authorization only: the injector must still claim its durable attempt
 * fence and enforce its own fixed account configuration before network I/O. */
export function authorizeManagedInjection(input: {
  token: string;
  originalBody: Uint8Array;
  providerBody: Uint8Array;
  verificationKey: KeyObject;
  now: number;
  maximumRequestBytes: number;
}): Readonly<ExecutionGrant> {
  if (!Number.isSafeInteger(input.maximumRequestBytes) || input.maximumRequestBytes <= 0
    || input.originalBody.byteLength > input.maximumRequestBytes
    || input.providerBody.byteLength > input.maximumRequestBytes) throw Error("injector_request_too_large");
  const grant = verifyExecutionGrant(input.token,input.originalBody,input.verificationKey,input.now);
  const expected = managedProviderRequest(grant,input.originalBody);
  if (expected.byteLength !== input.providerBody.byteLength || !timingSafeEqual(expected,input.providerBody)) {
    throw Error("injector_provider_body_mismatch");
  }
  return grant;
}
