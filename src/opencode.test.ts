import assert from "node:assert/strict";
import test from "node:test";
import {
  accountFromOpenCodeOAuth,
  normalizeOpenCodeApiRoot,
  openCodeUsageUrl,
  pollOpenCodeDeviceCode,
  requestOpenCodeDeviceCode,
} from "./opencode.js";
import {
  OPENCODE_CONSOLE_URL,
  OPENCODE_OAUTH_CLIENT_ID,
} from "./config.js";

test("normalizes OpenCode API roots and derives Go usage endpoints", () => {
  assert.equal(
    normalizeOpenCodeApiRoot("https://opencode.ai/zen/go/v1/"),
    "https://opencode.ai/zen/go",
  );
  assert.equal(
    openCodeUsageUrl("https://opencode.ai/zen"),
    "https://opencode.ai/zen/go/v1/usage",
  );
  assert.equal(
    openCodeUsageUrl("https://opencode.ai/zen/go"),
    "https://opencode.ai/zen/go/v1/usage",
  );
});

test("starts OpenCode Console device OAuth with the official contract", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody: any;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      device_code: "device-secret",
      user_code: "ABCD-EFGH",
      verification_uri_complete: "/device?user_code=ABCD-EFGH",
      expires_in: 900,
      interval: 7,
    });
  };

  try {
    const device = await requestOpenCodeDeviceCode();
    assert.equal(requestUrl, `${OPENCODE_CONSOLE_URL}/auth/device/code`);
    assert.deepEqual(requestBody, { client_id: OPENCODE_OAUTH_CLIENT_ID });
    assert.equal(device.userCode, "ABCD-EFGH");
    assert.equal(
      device.verificationUrl,
      "https://opencode.ai/device?user_code=ABCD-EFGH",
    );
    assert.equal(device.intervalSeconds, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("maps OpenCode device polling pending and successful responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({ error: "slow_down" }, { status: 400 });
    assert.deepEqual(await pollOpenCodeDeviceCode("device", 5), {
      status: "pending",
      intervalSeconds: 10,
    });

    globalThis.fetch = async () =>
      Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
      });
    const success = await pollOpenCodeDeviceCode("device", 5);
    assert.equal(success.status, "success");
    if (success.status === "success") {
      assert.equal(success.token.accessToken, "access-token");
      assert.equal(success.token.refreshToken, "refresh-token");
      assert.ok((success.token.expiresAt ?? 0) > Date.now());
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("creates an OpenCode account and discovers its Go API root", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer access-token",
    );
    if (url.endsWith("/api/user")) {
      return Response.json({ id: "usr_123", email: "user@example.test" });
    }
    if (url.endsWith("/api/orgs")) {
      return Response.json([{ id: "org_123", name: "Example Org" }]);
    }
    if (url.endsWith("/api/config")) {
      assert.equal(new Headers(init?.headers).get("x-org-id"), "org_123");
      return Response.json({
        config: {
          provider: {
            opencode: {
              api: "https://opencode.ai/zen/go/v1",
              options: {
                apiKey: "inference-key",
                headers: { "x-opencode-org-id": "org_123" },
              },
            },
          },
        },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  try {
    const account = await accountFromOpenCodeOAuth(
      {
        id: "flow",
        email: "",
        codeVerifier: "",
        createdAt: Date.now(),
        method: "device",
        provider: "opencode",
        status: "pending",
      },
      {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 3600_000,
      },
    );

    assert.equal(account.provider, "opencode");
    assert.equal(account.email, "user@example.test");
    assert.equal(account.opencodeAccountId, "usr_123");
    assert.equal(account.opencodeOrgId, "org_123");
    assert.equal(account.opencodeOrgName, "Example Org");
    assert.equal(account.baseUrl, "https://opencode.ai/zen/go");
    assert.equal(account.opencodeApiKey, "inference-key");
    assert.deepEqual(account.opencodeHeaders, { "x-opencode-org-id": "org_123" });
    assert.equal(account.upstreamMode, "responses");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolves Console credential references on every request and scopes legacy accounts", async () => {
  const { openCodeInferenceToken, openCodeAccountHeaders } = await import("./opencode.js");
  const { authorizationForAccountRequest } = await import("./local-runtime-discovery.js");
  const account = {
    id: "console", provider: "opencode" as const, enabled: true,
    accessToken: "old-session", opencodeApiKey: "{env:OPENCODE_CONSOLE_TOKEN}",
    opencodeOrgId: "org_selected",
    opencodeHeaders: { "x-opencode-org-id": "org_selected", Authorization: "Bearer stale" },
  };
  assert.equal(openCodeInferenceToken(account), "old-session");
  account.accessToken = "refreshed-session";
  assert.equal(authorizationForAccountRequest(account, "https://opencode.ai/inference/openai/v1/responses"), "Bearer refreshed-session");
  assert.deepEqual(openCodeAccountHeaders(account), {
    "x-opencode-org-id": "org_selected", "x-org-id": "org_selected",
  });
  account.opencodeApiKey = "inference-key";
  assert.equal(authorizationForAccountRequest(account, "https://opencode.ai/zen/v1/responses"), "Bearer inference-key");
  account.opencodeApiKey = "{env:UNRELATED_SECRET}";
  assert.throws(() => openCodeInferenceToken(account), /unsupported credential reference/);
  assert.equal(openCodeUsageUrl("https://opencode.ai/inference/openai/v1/"), undefined);
});

test("reauthentication keeps the selected workspace even when another sorts first", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/user")) return Response.json({ id: "usr_123", email: "user@example.test" });
    if (url.endsWith("/api/orgs")) return Response.json([
      { id: "org_other", name: "AAA Other" }, { id: "org_selected", name: "ZZ Selected" },
    ]);
    assert.ok(url.endsWith("/api/config"));
    assert.equal(new Headers(init?.headers).get("x-org-id"), "org_selected");
    return Response.json({ config: { provider: { opencode: {
      api: "https://opencode.ai/inference/openai", options: { apiKey: "{env:OPENCODE_CONSOLE_TOKEN}" },
    } } } });
  };
  const account = await accountFromOpenCodeOAuth(
    { id: "flow", email: "", codeVerifier: "", createdAt: Date.now(), status: "pending" },
    { accessToken: "new-session" },
    { id: "existing", provider: "opencode", accessToken: "old-session", enabled: true,
      opencodeAccountId: "usr_123", opencodeOrgId: "org_selected" },
  );
  assert.equal(account.opencodeOrgId, "org_selected");
  assert.equal(account.baseUrl, "https://opencode.ai/inference/openai");
});

test("fails OAuth connection when inference config discovery fails", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/user")) return Response.json({ id: "usr_123", email: "user@example.test" });
    if (url.endsWith("/api/orgs")) return Response.json([{ id: "org_selected", name: "Selected" }]);
    return Response.json({ error: "Unavailable" }, { status: 503 });
  };
  await assert.rejects(accountFromOpenCodeOAuth(
    { id: "flow", email: "", codeVerifier: "", createdAt: Date.now(), status: "pending" },
    { accessToken: "session" },
  ), /config.*failed 503/);
});
