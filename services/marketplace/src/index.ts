import http from "node:http";
import path from "node:path";
import { createMarketplaceApp } from "./app.js";
import { MarketplaceBroker } from "./service.js";
import { MarketplaceStore } from "./store.js";
import { StripeRestClient } from "./stripe.js";

const PORT = Number(process.env.PORT ?? 1460);
const HOST = process.env.HOST?.trim() || undefined;
const DATA_PATH = process.env.MARKETPLACE_DATA_PATH ?? "/data/marketplace.json";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const PUBLIC_URL = (
  process.env.MARKETPLACE_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`
).replace(/\/+$/, "");
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const CONNECT_WEBHOOK_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET ?? "";
const OPERATOR_TOKEN = process.env.MARKETPLACE_OPERATOR_TOKEN ?? "";
const ENCRYPTION_KEY = process.env.MARKETPLACE_ENCRYPTION_KEY;
const LIVEMODE = STRIPE_SECRET_KEY.startsWith("sk_live_");
const COMMISSION_BPS = Number(process.env.MARKETPLACE_COMMISSION_BPS ?? 500);

if (!STRIPE_SECRET_KEY) {
  console.warn("[marketplace] STRIPE_SECRET_KEY is not set: checkout and onboarding will fail");
}
if (!OPERATOR_TOKEN) {
  console.warn("[marketplace] MARKETPLACE_OPERATOR_TOKEN is not set: operator API is disabled");
}
if (!ENCRYPTION_KEY) {
  console.warn(
    "[marketplace] MARKETPLACE_ENCRYPTION_KEY is not set: instance secrets are stored base64-encoded",
  );
}

const store = new MarketplaceStore(DATA_PATH);
await store.init();

const broker = new MarketplaceBroker({
  store,
  stripe: new StripeRestClient({
    secretKey: STRIPE_SECRET_KEY,
    apiVersion: process.env.STRIPE_API_VERSION,
    baseUrl: process.env.STRIPE_API_BASE_URL,
  }),
  publicUrl: PUBLIC_URL,
  livemode: LIVEMODE,
  encryptionKey: ENCRYPTION_KEY,
  commissionBps: Number.isInteger(COMMISSION_BPS) ? COMMISSION_BPS : 500,
});

const app = createMarketplaceApp({
  broker,
  store,
  webhookSecret: WEBHOOK_SECRET,
  connectWebhookSecret: CONNECT_WEBHOOK_SECRET,
  operatorToken: OPERATOR_TOKEN,
});

const server = http.createServer(app);
server.listen(PORT, HOST, () => {
  console.log(
    `[marketplace] listening on ${PUBLIC_URL} (${LIVEMODE ? "live" : "test"} mode, data ${path.resolve(DATA_PATH)})`,
  );
});

function shutdown(signal: string) {
  console.log(`[marketplace] ${signal}, flushing`);
  server.close(() => {
    void store.flush().finally(() => process.exit(0));
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
