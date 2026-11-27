import assert from "node:assert/strict";
import test from "node:test";
import {
  createCloudflareAccessProvisioner,
  parseCloudflareAccessApplications,
} from "./cloudflare-access.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const APP_ID = "b1f0c2d3-0000-0000-0000-000000000000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    apiToken: "cf-secret-token",
    defaultAccountId: ACCOUNT_ID,
    tokenDuration: "8760h",
    applications: { "staging-worker": { applicationId: APP_ID } },
    ...overrides,
  };
}

test("CLOUDFLARE_ACCESS_APPS accepts a bare id or an account override", () => {
  const parsed = parseCloudflareAccessApplications(
    JSON.stringify({
      "staging-worker": APP_ID,
      litellm: { applicationId: APP_ID, accountId: ACCOUNT_ID },
    }),
  );
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.applications, {
    "staging-worker": { applicationId: APP_ID },
    litellm: { applicationId: APP_ID, accountId: ACCOUNT_ID },
  });
});

test("CLOUDFLARE_ACCESS_APPS reports invalid JSON without throwing", () => {
  const parsed = parseCloudflareAccessApplications("{nope");
  assert.match(parsed.error ?? "", /must be a JSON object/);
  assert.deepEqual(parsed.applications, {});
});

test("provisioning creates one service token and one Service Auth policy", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown; auth?: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body,
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    if (String(input).endsWith("/access/service_tokens")) {
      return jsonResponse({
        success: true,
        result: {
          id: "token-id",
          client_id: "client-id.access",
          client_secret: "client-secret",
          expires_at: "2027-01-01T00:00:00Z",
        },
      });
    }
    return jsonResponse({ success: true, result: { id: "policy-id" } });
  }) as typeof fetch;

  const provisioner = createCloudflareAccessProvisioner(settings(), fetchImpl);
  const provisioned = await provisioner.provision(
    "staging-worker",
    "multivibe-staging-worker-key-id",
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "POST");
  assert.equal(
    calls[0].url,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/service_tokens`,
  );
  assert.equal(calls[0].auth, "Bearer cf-secret-token");
  assert.deepEqual(calls[0].body, {
    name: "multivibe-staging-worker-key-id",
    duration: "8760h",
    tags: { managed_by: "multivibe", application: "staging-worker" },
  });
  assert.equal(
    calls[1].url,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/apps/${APP_ID}/policies`,
  );
  assert.deepEqual(calls[1].body, {
    name: "multivibe-staging-worker-key-id",
    decision: "non_identity",
    include: [{ service_token: { token_id: "token-id" } }],
  });
  assert.deepEqual(provisioned, {
    credential: {
      accountId: ACCOUNT_ID,
      applicationId: APP_ID,
      policyId: "policy-id",
      serviceTokenId: "token-id",
      clientId: "client-id.access",
      expiresAt: "2027-01-01T00:00:00Z",
    },
    clientSecret: "client-secret",
  });
});

test("a failed policy creation rolls the service token back", async () => {
  const methods: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    methods.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (methods.length === 1) {
      return jsonResponse({
        success: true,
        result: {
          id: "token-id",
          client_id: "client-id.access",
          client_secret: "client-secret",
        },
      });
    }
    if (methods.length === 2) {
      return jsonResponse(
        { success: false, errors: [{ message: "policy denied" }] },
        403,
      );
    }
    return jsonResponse({ success: true, result: { id: "token-id" } });
  }) as typeof fetch;

  const provisioner = createCloudflareAccessProvisioner(settings(), fetchImpl);
  await assert.rejects(
    provisioner.provision("staging-worker", "name"),
    /policy denied.*deleted/s,
  );
  assert.equal(methods.length, 3);
  assert.match(methods[2], /^DELETE .*\/access\/service_tokens\/token-id$/);
});

test("revocation deletes the token before the policy", async () => {
  const methods: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    methods.push(`${init?.method ?? "GET"} ${String(input)}`);
    return jsonResponse({ success: true, result: {} });
  }) as typeof fetch;

  const provisioner = createCloudflareAccessProvisioner(settings(), fetchImpl);
  const result = await provisioner.revoke({
    accountId: ACCOUNT_ID,
    applicationId: APP_ID,
    policyId: "policy-id",
    serviceTokenId: "token-id",
    clientId: "client-id.access",
  });

  assert.deepEqual(result, { policyDeleted: true });
  assert.equal(methods.length, 2);
  assert.match(methods[0], /^DELETE .*\/access\/service_tokens\/token-id$/);
  assert.match(
    methods[1],
    new RegExp(`^DELETE .*/access/apps/${APP_ID}/policies/policy-id$`),
  );
});

test("an already deleted service token is treated as revoked", async () => {
  const fetchImpl = (async () =>
    jsonResponse({ success: false, errors: [{ message: "not found" }] }, 404)) as typeof fetch;
  const provisioner = createCloudflareAccessProvisioner(settings(), fetchImpl);
  const result = await provisioner.revoke({
    accountId: ACCOUNT_ID,
    applicationId: APP_ID,
    policyId: "policy-id",
    serviceTokenId: "token-id",
    clientId: "client-id.access",
  });
  assert.deepEqual(result, { policyDeleted: true });
});

test("provisioning stays disabled unless the operator opts in", async () => {
  const provisioner = createCloudflareAccessProvisioner(
    settings({ enabled: false }),
  );
  assert.equal(provisioner.describe().provisioningEnabled, false);
  assert.equal(provisioner.canManage("staging-worker"), false);
  await assert.rejects(
    provisioner.provision("staging-worker", "name"),
    /disabled/,
  );
});

test("an unmapped application is refused before any API call", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return jsonResponse({ success: true });
  }) as typeof fetch;
  const provisioner = createCloudflareAccessProvisioner(settings(), fetchImpl);
  assert.equal(provisioner.canManage("other-app"), false);
  await assert.rejects(provisioner.provision("other-app", "name"), /No Cloudflare Access application/);
  assert.equal(called, false);
});
