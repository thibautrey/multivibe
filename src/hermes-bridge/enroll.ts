/**
 * One-time enrollment.
 *
 * The prompt the operator sends contains a short-lived enrollment code, never a
 * long-lived secret. The bridge exchanges that code for its credentials, stores
 * them in the OS secret store, and refuses to reuse the code. A leaked prompt
 * therefore grants nothing after the first machine enrols.
 */

export type EnrollmentPayload = {
  code: string;
  /** The edge API key issued for this machine. */
  edgeApiKey: string;
  accessClientId?: string;
  accessClientSecret?: string;
  /** Model substitutions the operator has approved for this client. */
  mappings?: Array<{ from: string; edge: string; nous: string }>;
  expiresAt: number;
};

export type ExchangeResult =
  | { ok: true; payload: EnrollmentPayload }
  | { ok: false; reason: "expired" | "invalid" | "used" | "network" | "unsupported" };

const CODE_PATTERN = /^mvenr_[A-Za-z0-9_-]{32,128}$/;

export function isEnrollmentCode(value: string): boolean {
  return CODE_PATTERN.test(value.trim());
}

/**
 * Parse `mvenr_...` enrollment codes. The code itself carries no secret; the
 * exchange endpoint is what authorises it.
 */
export function parseEnrollmentCode(raw: string): string | undefined {
  const value = raw.trim();
  if (!isEnrollmentCode(value)) return undefined;
  return value;
}

/**
 * Exchange an enrollment code with the control plane.
 *
 * Redirects are refused: an Access login page must never be accepted as a
 * credential response.
 */
/**
 * Build the exchange URL from an enrollment base.
 *
 * Strips a trailing `/v1` rather than appending to it: an operator who pastes
 * the inference URL out of habit would otherwise get a 404 on a path that looks
 * right, and the failure would read as a server bug.
 */
export function enrollmentExchangeUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
  return `${trimmed}/hermes-bridge/enrollment/exchange`;
}

export async function exchangeEnrollment(options: {
  endpoint: string;
  code: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ExchangeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(enrollmentExchangeUrl(options.endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: options.code }),
      redirect: "error",
      signal: options.signal ?? AbortSignal.timeout(20_000),
    });
  } catch (error) {
    // A refused redirect (an Access login page) lands here too. Say so, because
    // "network" sends an operator looking for a firewall that is not the problem.
    const message = String((error as Error).message ?? "");
    if (/redirect/i.test(message)) return { ok: false, reason: "invalid" };
    return { ok: false, reason: "network" };
  }
  if (response.status === 404) return { ok: false, reason: "unsupported" };
  if (response.status === 410) return { ok: false, reason: "used" };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "invalid" };
  if (!response.ok) return { ok: false, reason: "invalid" };
  let payload: EnrollmentPayload;
  try {
    payload = (await response.json()) as EnrollmentPayload;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (typeof payload.edgeApiKey !== "string" || !payload.edgeApiKey.length) {
    return { ok: false, reason: "invalid" };
  }
  if (typeof payload.expiresAt === "number" && payload.expiresAt < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}
