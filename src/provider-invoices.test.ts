import assert from "node:assert/strict";
import test from "node:test";
import { sdkProviderCatalog } from "./ai-sdk/catalog.js";
import { configuredInvoiceProviders, deepinfraInvoices, invoiceDocumentUrl, invoiceOverview, INVOICE_PORTALS, INVOICE_UNSUPPORTED, normalizeCloudInvoices } from "./provider-invoices.js";
import type { Account } from "./types.js";
const account = (overrides: Partial<Account> = {}): Account => ({ id: "a", provider: "openai", accessToken: "private-key", enabled: true, ...overrides });
const rawInvoice = { invoiceId: "in_live", currency: "USD", amountDueMinor: "2050", paid: true, status: "paid", observedAt: "2026-09-10T12:00:00Z", invoicePdfUrl: "https://pay.stripe.com/invoice/test/pdf" };
const live = (data: unknown[] = [rawInvoice]) => ({ environment: "live", financialEnvironment: "live", data });

test("every picker provider has an explicit invoice capability decision", () => {
  const ids = [...sdkProviderCatalog().providers.map(p => p.id), "openai", "github-copilot", "xai", "opencode", "mistral", "zai", "nvidia-pair", "openai-compatible"];
  for (const id of ids) assert.ok(Boolean(INVOICE_PORTALS[id]) !== Boolean(INVOICE_UNSUPPORTED[id]), id);
});
test("only configured vendor accounts enable invoice sources; no credentials or custom endpoints escape", () => {
  assert.deepEqual(configuredInvoiceProviders([]), []);
  assert.deepEqual(configuredInvoiceProviders([account({ provider: "openai-compatible", baseUrl: "https://attacker.test/billing" }), account({ multivibeCloud: true }), account({ localRuntime: {} as Account["localRuntime"] })]), []);
  const result = configuredInvoiceProviders([account({ email: "first@example.test" }), account({ id: "b", email: "second@example.test", enabled: false }), account({ id: "c", provider: "ai-sdk", sdkProvider: "huggingface" })]);
  assert.equal(result.length, 2);
  assert.equal(result.find(p => p.id === "openai")?.accounts.length, 2);
  assert.ok(!JSON.stringify(result).includes("private-key"));
  assert.equal(result.find(p => p.id === "huggingface")?.billingUrl, "https://huggingface.co/settings/billing/invoices");
});
test("Cloud requires actual live invoices; balances, test, shadow and drafts do not count", async () => {
  for (const payload of [live([]), { ...live(), environment: "test" }, { ...live(), financialEnvironment: "shadow" }, live([{...rawInvoice, status: "draft"}]), live([{ totalAvailableUsd: "100" }])]) {
    const invoices = normalizeCloudInvoices(payload);
    assert.deepEqual((await invoiceOverview([], { getInvoices: async () => invoices })).providers, []);
  }
  const invoices = normalizeCloudInvoices(live());
  const overview = await invoiceOverview([], { getInvoices: async () => invoices });
  assert.equal(overview.providers[0].id, "multivibe-cloud");
  assert.equal(overview.providers[0].invoices[0].amountMinor, "2050");
  assert.equal(overview.providers[0].invoices[0].currency, "USD");
});
test("Cloud errors remain distinct from no invoices and do not hide provider portals", async () => {
  const overview = await invoiceOverview([account()], { getInvoices: async () => { throw new Error("secret upstream response"); } });
  assert.equal(overview.cloudUnavailable, true);
  assert.equal(overview.providers.length, 1);
  assert.ok(!JSON.stringify(overview).includes("secret"));
  assert.throws(() => normalizeCloudInvoices({ data: null }));
});
test("invoice projection rejects malformed amounts and unsafe document URLs and deduplicates", () => {
  for (const value of ["javascript:alert(1)", "https://evil.test/invoice", "https://invoice.stripe.com.evil.test/a", "https://key@invoice.stripe.com/a", "http://invoice.stripe.com/a", "https://invoice.stripe.com:8443/a"]) assert.equal(invoiceDocumentUrl(value), undefined);
  for (const amount of ["NaN", "1.50", "-1", "9999999999999999", 2050]) assert.equal(normalizeCloudInvoices(live([{...rawInvoice, amountDueMinor: amount}])).length, 0);
  const invoices = normalizeCloudInvoices(live([rawInvoice, rawInvoice, {...rawInvoice, invoiceId: "in_other", invoicePdfUrl: "javascript:bad", accessToken: "private"}]));
  assert.equal(invoices.length, 2);
  assert.equal(invoices[1].documentUrl, undefined);
  assert.ok(!JSON.stringify(invoices).includes("private"));
});
test("DeepInfra follows documented pagination at a fixed credential destination and never guesses currency", async () => {
  const calls: string[] = [];
  const result = await deepinfraInvoices("private", async (url, init) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    return Response.json({ invoices: [{ id: calls.length === 1 ? "first" : "second", total: 2000, created: 1789120000, status: "paid", invoice_pdf: "https://pay.stripe.com/invoice/test/pdf" }], has_more: calls.length === 1, next_cursor: calls.length === 1 ? "first" : null });
  });
  assert.deepEqual(calls, ["https://api.deepinfra.com/payment/invoices?limit=50", "https://api.deepinfra.com/payment/invoices?limit=50&starting_after=first"]);
  assert.equal(result.invoices.length, 2);
  assert.equal(result.invoices[0].amountMinor, undefined);
  assert.equal(result.limited, false);
  await assert.rejects(deepinfraInvoices("private", async () => new Response("secret", {status: 403})), /invoice_access_unavailable/);
});
test("DeepInfra bounds pagination and rejects unexpected response schemas", async () => {
  let count = 0;
  const result = await deepinfraInvoices("private", async () => Response.json({ invoices: [], has_more: true, next_cursor: String(++count) }));
  assert.equal(count, 4);
  assert.equal(result.limited, true);
  await assert.rejects(deepinfraInvoices("private", async () => Response.json({ balance: 100 })), /invalid_invoice_response/);
});
