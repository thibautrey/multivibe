import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createAdminRouter, type AdminRoutesOptions } from "./index.js";
import { sessionKeyFor } from "../../session-identity.js";
import { createTraceManager, type TraceEntry } from "../../traces.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BASE = 1_728_000_000_000;

function attempt(
  overrides: Partial<TraceEntry> & Pick<TraceEntry, "id" | "at">,
): TraceEntry {
  return {
    route: "/v1/responses",
    traceKind: "upstream-attempt",
    application: "codex",
    codexSessionId: "thread-one",
    provider: "openai",
    model: "gpt-5.4-mini",
    status: 200,
    isError: false,
    stream: true,
    latencyMs: 900,
    lifecycleState: "completed",
    usageStatus: "measured",
    ...overrides,
  };
}

function options(traces: TraceEntry[]): AdminRoutesOptions {
  return {
    store: {} as AdminRoutesOptions["store"],
    oauthStore: {} as AdminRoutesOptions["oauthStore"],
    traceManager: {
      pageSizeMax: 100,
      readStatsHistoryRange: async () => traces,
    } as unknown as AdminRoutesOptions["traceManager"],
    codexProjectRegistry: {} as AdminRoutesOptions["codexProjectRegistry"],
    oauthConfig: {} as AdminRoutesOptions["oauthConfig"],
    openaiBaseUrl: "https://example.test",
    mistralBaseUrl: "https://example.test",
    zaiBaseUrl: "https://example.test",
    codexProjectRegistrationToken: "",
    configuredProxyApiKeys: [],
    storagePaths: {
      accountsPath: "/data/accounts.json",
      oauthStatePath: "/data/oauth.json",
      tracePath: "/data/traces.jsonl",
      traceStatsHistoryPath: "/data/trace-stats.jsonl",
      codexProjectsPath: "/data/projects.json",
    },
  };
}

async function withServer(
  adminOptions: AdminRoutesOptions,
  run: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(adminOptions));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("admin session stats expose aggregates, coverage and turn details", async () => {
  const traces: TraceEntry[] = [
    attempt({
      id: "turn-1",
      at: BASE,
      clientRequestId: "request-1",
      tokensInput: 12_000,
      tokensOutput: 300,
    }),
    attempt({
      id: "turn-2",
      at: BASE + 1_000,
      clientRequestId: "request-2",
      tokensInput: 14_000,
      tokensInputCached: 12_000,
      tokensOutput: 250,
    }),
    attempt({
      id: "anonymous",
      at: BASE + 2_000,
      codexSessionId: undefined,
      clientRequestId: "request-3",
      tokensInput: 1_000,
      tokensOutput: 50,
    }),
  ];

  await withServer(options(traces), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/stats/sessions?sinceMs=0`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.coverage.totalAttempts, 3);
    assert.equal(body.coverage.identifiedAttempts, 2);
    assert.equal(body.coverage.ratio, 2 / 3);
    assert.equal(body.summary.sessions, 1);
    assert.equal(body.summary.initialInputTokensMedian, 12_000);
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].sessionKey, sessionKeyFor("codex", "thread-one"));

    const key = body.sessions[0].sessionKey as string;
    const detail = await fetch(`${baseUrl}/admin/stats/sessions/${key}/turns`);
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()) as any;
    assert.equal(detailBody.turns.length, 2);
    assert.deepEqual(
      detailBody.turns.map((turn: any) => turn.clientRequestId),
      ["request-1", "request-2"],
    );

    const invalid = await fetch(
      `${baseUrl}/admin/stats/sessions/not-a-key/turns`,
    );
    assert.equal(invalid.status, 400);
    const missing = await fetch(
      `${baseUrl}/admin/stats/sessions/${"0".repeat(24)}/turns`,
    );
    assert.equal(missing.status, 404);
  });
});


test("indexed admin endpoints expose complete totals, account metadata and paginated session turns", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-admin-index-"));
  const historyFilePath = path.join(dir, "history.jsonl");
  const records = Array.from({ length: 203 }, (_, i) => attempt({ id: `indexed-${i}`, at: BASE + i, accountId: "account", clientRequestId: `request-${i}`, tokensInput: 100 + i, tokensOutput: 5 }));
  await fs.writeFile(historyFilePath, records.map(t => JSON.stringify(t)).join("\n") + "\n");
  const manager = createTraceManager({ filePath: path.join(dir, "journal.jsonl"), historyFilePath, indexedHistoryPath: path.join(dir, "index.sqlite"), externalWriter: true });
  t.after(async () => { await manager.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const opts = options([]);
  opts.traceManager = manager;
  opts.store = { listAccounts: async () => [{ id: "account", provider: "openai", email: "fixture@example.test", enabled: true }] } as any;
  await manager.initialize(); await manager.queryAnalytics!("sync", {});
  await withServer(opts, async (base) => {
    const [stats, usage, sessions] = await Promise.all(["traces", "usage", "sessions"].map(async route => {
      const r = await fetch(`${base}/admin/stats/${route}`); assert.equal(r.status, 200); return r.json();
    }));
    assert.equal(stats.stats.totals.upstreamAttempts, 203);
    assert.equal(stats.analytics.ready, true);
    assert.equal(usage.totals.requests, 203);
    assert.equal(usage.byAccount[0].account.email, "fixture@example.test");
    assert.equal(sessions.summary.turns, 203);
    const key = sessions.sessions[0].sessionKey;
    const r = await fetch(`${base}/admin/stats/sessions/${key}/turns?limit=10&offset=200`);
    const page = await r.json(); assert.equal(page.total, 203); assert.equal(page.turns.length, 3); assert.equal(page.turns[0].clientRequestId, "request-200");
    const exact = await fetch(`${base}/admin/stats/traces?sinceMs=${BASE + 10}&untilMs=${BASE + 10}`).then(r => r.json());
    assert.equal(exact.stats.totals.upstreamAttempts, 1);
  });
});
