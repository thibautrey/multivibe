import type {
  StoredProxyApiKeyCloudflareAccess,
} from "./types.js";

/**
 * Cloudflare Access service-token provisioning for dashboard API keys.
 *
 * MultiVibe never stores the service-token client secret. Cloudflare only
 * returns it when the token is created, so the creation response is the only
 * place it is exposed and the operator has to save it then.
 */

const API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_TOKEN_DURATION = "8760h";

export type CloudflareAccessApplication = {
  applicationId: string;
  /** Overrides CLOUDFLARE_ACCOUNT_ID for this application. */
  accountId?: string;
};

export type CloudflareAccessApplications = Record<
  string,
  CloudflareAccessApplication
>;

export type CloudflareAccessSettings = {
  /** Operator opt-in. Provisioning is never enabled implicitly. */
  enabled: boolean;
  apiToken?: string;
  defaultAccountId?: string;
  tokenDuration: string;
  applications: CloudflareAccessApplications;
  /** Configuration problem surfaced to the operator instead of crashing. */
  error?: string;
};

export type CloudflareAccessCapability = {
  provisioningEnabled: boolean;
  configured: boolean;
  applications: string[];
  error?: string;
};

export type ProvisionedCloudflareAccess = {
  credential: StoredProxyApiKeyCloudflareAccess;
  clientSecret: string;
};

export type CloudflareAccessProvisioner = {
  describe(): CloudflareAccessCapability;
  canManage(application: string): boolean;
  provision(
    application: string,
    serviceTokenName: string,
  ): Promise<ProvisionedCloudflareAccess>;
  revoke(
    credential: StoredProxyApiKeyCloudflareAccess,
  ): Promise<{ policyDeleted: boolean }>;
};

export class CloudflareAccessError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "CloudflareAccessError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parses CLOUDFLARE_ACCESS_APPS. Accepts either a bare application id or an
 * object with an application id and an optional account override:
 *
 *   {"staging-worker":"<access-app-id>"}
 *   {"staging-worker":{"applicationId":"<access-app-id>","accountId":"..."}}
 *
 * Invalid input is reported instead of thrown so an unused feature flag cannot
 * make MultiVibe fail to boot.
 */
export function parseCloudflareAccessApplications(value: unknown): {
  applications: CloudflareAccessApplications;
  error?: string;
} {
  if (value === undefined || value === null || value === "") {
    return { applications: {} };
  }
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {
        applications: {},
        error:
          'CLOUDFLARE_ACCESS_APPS must be a JSON object such as {"staging-worker":"<access-app-id>"}',
      };
    }
  }
  if (!isRecord(parsed)) {
    return {
      applications: {},
      error:
        'CLOUDFLARE_ACCESS_APPS must be a JSON object such as {"staging-worker":"<access-app-id>"}',
    };
  }

  const applications: CloudflareAccessApplications = {};
  for (const [rawApplication, rawValue] of Object.entries(parsed)) {
    const application = rawApplication.trim();
    if (!application) {
      return {
        applications: {},
        error: "CLOUDFLARE_ACCESS_APPS application names must be non-empty",
      };
    }
    if (typeof rawValue === "string") {
      const applicationId = rawValue.trim();
      if (!applicationId) {
        return {
          applications: {},
          error: `CLOUDFLARE_ACCESS_APPS has an empty application id for "${application}"`,
        };
      }
      applications[application] = { applicationId };
      continue;
    }
    if (!isRecord(rawValue)) {
      return {
        applications: {},
        error: `CLOUDFLARE_ACCESS_APPS entry for "${application}" must be a string or an object`,
      };
    }
    const applicationId =
      typeof rawValue.applicationId === "string"
        ? rawValue.applicationId.trim()
        : "";
    if (!applicationId) {
      return {
        applications: {},
        error: `CLOUDFLARE_ACCESS_APPS entry for "${application}" needs a non-empty applicationId`,
      };
    }
    const accountId =
      typeof rawValue.accountId === "string"
        ? rawValue.accountId.trim()
        : undefined;
    applications[application] = {
      applicationId,
      ...(accountId ? { accountId } : {}),
    };
  }
  return { applications };
}

type FetchLike = typeof fetch;

type CloudflareEnvelope<T> = {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
};

type ServiceTokenResult = {
  id?: string;
  client_id?: string;
  client_secret?: string;
  expires_at?: string;
};

type PolicyResult = {
  id?: string;
};

function errorDetail(payload: unknown, httpStatus: number, httpStatusText: string): string {
  if (isRecord(payload)) {
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    const messages = errors
      .map((entry) =>
        isRecord(entry) && typeof entry.message === "string" ? entry.message : "",
      )
      .filter(Boolean);
    if (messages.length) return messages.join("; ");
  }
  return httpStatusText || `HTTP ${httpStatus}`;
}

export function createCloudflareAccessProvisioner(
  settings: CloudflareAccessSettings,
  fetchImpl: FetchLike = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): CloudflareAccessProvisioner {
  const apiToken = settings.apiToken?.trim() ?? "";
  const defaultAccountId = settings.defaultAccountId?.trim() ?? "";
  const tokenDuration = settings.tokenDuration.trim() || DEFAULT_TOKEN_DURATION;

  const configurationError = (application?: string): string | undefined => {
    if (!settings.enabled) {
      return "Cloudflare Access provisioning is disabled. Set CLOUDFLARE_ACCESS_PROVISIONING=true to enable it.";
    }
    if (settings.error) return settings.error;
    if (!apiToken) {
      return "CLOUDFLARE_API_TOKEN is not set. Cloudflare Access provisioning cannot call the Cloudflare API without it.";
    }
    if (application) {
      const mapped = settings.applications[application];
      if (!mapped) {
        return `No Cloudflare Access application is mapped for "${application}" in CLOUDFLARE_ACCESS_APPS.`;
      }
      if (!(mapped.accountId ?? defaultAccountId)) {
        return `No Cloudflare account id is configured for "${application}". Set CLOUDFLARE_ACCOUNT_ID or an accountId in CLOUDFLARE_ACCESS_APPS.`;
      }
    }
    return undefined;
  };

  async function request<T>(
    accountId: string,
    method: "GET" | "POST" | "DELETE",
    resourcePath: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${API_BASE}/accounts/${encodeURIComponent(accountId)}${resourcePath}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CloudflareAccessError(
        `Cloudflare API is unreachable: ${message}`,
      );
    }

    const raw = await response.text();
    let payload: unknown;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = undefined;
      }
    }
    const failed =
      !response.ok ||
      (isRecord(payload) && payload.success === false);
    if (failed) {
      const detail = isRecord(payload)
        ? errorDetail(payload, response.status, response.statusText)
        : raw.slice(0, 300) || response.statusText;
      throw new CloudflareAccessError(
        `Cloudflare API ${method} ${resourcePath} failed (${response.status}): ${detail}`,
        response.status,
      );
    }
    if (isRecord(payload) && "result" in payload) {
      return payload.result as T;
    }
    return undefined as T;
  }

  function accountFor(application: string): string {
    const mapped = settings.applications[application];
    return (mapped?.accountId ?? defaultAccountId).trim();
  }

  async function deleteServiceToken(
    accountId: string,
    serviceTokenId: string,
  ): Promise<void> {
    try {
      await request(
        accountId,
        "DELETE",
        `/access/service_tokens/${encodeURIComponent(serviceTokenId)}`,
      );
    } catch (error) {
      // Already deleted in the dashboard is the desired end state.
      if (error instanceof CloudflareAccessError && error.status === 404) return;
      throw error;
    }
  }

  async function deletePolicy(
    accountId: string,
    credential: StoredProxyApiKeyCloudflareAccess,
  ): Promise<boolean> {
    if (!credential.policyId) return true;
    try {
      await request(
        accountId,
        "DELETE",
        `/access/apps/${encodeURIComponent(credential.applicationId)}/policies/${encodeURIComponent(credential.policyId)}`,
      );
      return true;
    } catch (error) {
      if (error instanceof CloudflareAccessError && error.status === 404) return true;
      console.warn(
        `cloudflare access: the service token was revoked, but its policy ${credential.policyId} could not be deleted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  return {
    describe() {
      return {
        provisioningEnabled: settings.enabled,
        configured: settings.enabled && !configurationError(),
        applications: Object.keys(settings.applications).sort(),
        ...(configurationError() ? { error: configurationError() } : {}),
      };
    },

    canManage(application: string) {
      return configurationError(application) === undefined;
    },

    async provision(application, serviceTokenName) {
      const problem = configurationError(application);
      if (problem) throw new CloudflareAccessError(problem);
      const mapped = settings.applications[application]!;
      const accountId = accountFor(application);
      const name = serviceTokenName.slice(0, 120);

      const token = await request<ServiceTokenResult>(
        accountId,
        "POST",
        "/access/service_tokens",
        {
          name,
          duration: tokenDuration,
          tags: { managed_by: "multivibe", application },
        },
      );
      if (!token?.id || !token.client_id || !token.client_secret) {
        if (token?.id) {
          await deleteServiceToken(accountId, token.id).catch(() => undefined);
        }
        throw new CloudflareAccessError(
          "Cloudflare did not return a complete service token (id, client id and client secret).",
        );
      }

      let policy: PolicyResult | undefined;
      try {
        policy = await request<PolicyResult>(
          accountId,
          "POST",
          `/access/apps/${encodeURIComponent(mapped.applicationId)}/policies`,
          {
            name,
            decision: "non_identity",
            include: [{ service_token: { token_id: token.id } }],
          },
        );
      } catch (error) {
        const original = error instanceof Error ? error.message : String(error);
        let rollback = true;
        try {
          await deleteServiceToken(accountId, token.id);
        } catch {
          rollback = false;
        }
        throw new CloudflareAccessError(
          `${original}${
            rollback
              ? " The unlinked service token was deleted."
              : ` The service token ${token.id} could not be deleted and must be removed manually in Cloudflare.`
          }`,
          error instanceof CloudflareAccessError ? error.status : undefined,
        );
      }
      if (!policy?.id) {
        // Without a policy id the token cannot be revoked cleanly later.
        await deleteServiceToken(accountId, token.id).catch(() => undefined);
        throw new CloudflareAccessError(
          "Cloudflare created the Access policy but did not return its id; the service token was rolled back.",
        );
      }

      return {
        credential: {
          accountId,
          applicationId: mapped.applicationId,
          policyId: policy.id,
          serviceTokenId: token.id,
          clientId: token.client_id,
          ...(token.expires_at ? { expiresAt: token.expires_at } : {}),
        },
        clientSecret: token.client_secret,
      };
    },

    async revoke(credential) {
      // Delete the credential first: that is what actually cuts access. The
      // policy is only cleanup and may legitimately outlive a failed call.
      await deleteServiceToken(credential.accountId, credential.serviceTokenId);
      const policyDeleted = await deletePolicy(
        credential.accountId,
        credential,
      );
      return { policyDeleted };
    },
  };
}
