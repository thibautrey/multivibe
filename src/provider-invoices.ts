import type { Account } from "./types.js";

export type Invoice = { id: string; date?: string; amountMinor?: string; currency?: string; status?: string; documentUrl?: string };
export type InvoiceProvider = { id: string; provider: string; name: string; accounts: string[]; billingUrl: string; instruction: string; invoices: Invoice[]; status: "portal" | "ready" | "unavailable"; limited?: boolean };
export type InvoiceOverview = { providers: InvoiceProvider[]; cloudUnavailable: boolean };
type Portal = { name: string; url: string; instruction: string };
const portal = (name: string, url: string, instruction = "Open billing to view and download invoices."): Portal => ({ name, url, instruction });

/** Fixed public destinations, never derived from account endpoints or credentials. See docs/providers/invoices.md. */
export const INVOICE_PORTALS: Record<string, Portal> = {
  openai: portal("ChatGPT", "https://chatgpt.com/#settings/Account", "Payment → Manage → Invoice history. App Store purchases use Apple or Google receipts."),
  "github-copilot": portal("GitHub Copilot", "https://github.com/settings/billing/payment_information", "Payment history. For an organization subscription, open its billing settings."),
  xai: portal("Grok Build", "https://grok.com", "Settings → Subscription → Manage. X Premium+ and mobile purchases use the original store’s receipts."),
  opencode: portal("OpenCode Zen / Go", "https://opencode.ai/auth", "Choose your workspace, then Billing."),
  mistral: portal("Mistral", "https://admin.mistral.ai/organization/billing"),
  codestral: portal("Mistral Codestral", "https://admin.mistral.ai/organization/billing"),
  zai: portal("Z.AI Coding Plan", "https://z.ai/manage-apikey/billing", "Open your Coding Plan billing and payment history."),
  anthropic: portal("Anthropic API", "https://platform.claude.com/settings/billing", "API billing → invoices. Claude app subscriptions are billed separately."),
  google: portal("Google Gemini", "https://console.cloud.google.com/billing", "Select the project’s billing account → Documents."),
  "vertex-express": portal("Vertex AI", "https://console.cloud.google.com/billing", "Select the billing account → Documents."),
  bedrock: portal("AWS Bedrock", "https://console.aws.amazon.com/billing/home#/bills", "Choose a billing period and download its invoice. Payer-account access may be required."),
  "azure-foundry": portal("Azure AI Foundry", "https://portal.azure.com/#view/Microsoft_Azure_GTM/ModernBillingMenuBlade/~/BillingAccounts", "Select your billing account → Invoices."),
  cloudflare: portal("Cloudflare Workers AI", "https://dash.cloudflare.com", "Select your account → Billing → Invoices."),
  openrouter: portal("OpenRouter", "https://openrouter.ai/settings/credits", "Payment history → open a payment to download its invoice."),
  deepseek: portal("DeepSeek", "https://platform.deepseek.com", "Billing → payment history and invoices."),
  groq: portal("Groq", "https://console.groq.com/settings/billing", "Open billing and payment history for your organization."),
  togetherai: portal("Together AI", "https://api.together.ai/settings/organization/~current/billing", "Payment methods & invoices."),
  perplexity: portal("Perplexity API", "https://console.perplexity.ai/project/billing", "Invoice history → Invoices."),
  fireworks: portal("Fireworks AI", "https://app.fireworks.ai", "Select your account → Billing → Invoices."),
  deepinfra: portal("DeepInfra", "https://deepinfra.com/dash/billing"),
  nebius: portal("Nebius AI Studio", "https://studio.nebius.com", "Open your organization’s billing. Bank-transfer invoices may be delivered by email."),
  sambanova: portal("SambaNova Cloud", "https://cloud.sambanova.ai", "Open account settings → billing."),
  siliconflow: portal("SiliconFlow", "https://cloud.siliconflow.com", "Open billing and payment history."),
  novita: portal("Novita AI", "https://novita.ai/console", "Open billing and invoice history."),
  cohere: portal("Cohere", "https://dashboard.cohere.com/billing"),
  ai21: portal("AI21 Labs", "https://studio.ai21.com", "Open your organization’s billing settings."),
  venice: portal("Venice AI", "https://venice.ai", "Manage subscription or API purchases → payment history."),
  kilo: portal("Kilo", "https://app.kilo.ai", "Open Billing for Gateway credits or Kilo Pass."),
  "byteplus-coding": portal("BytePlus Coding Plan", "https://console.byteplus.com/finance", "Billing → Invoices. Select the account used for your Coding Plan."),
  "ollama-cloud": portal("Ollama Cloud", "https://ollama.com/settings", "Manage your subscription → billing history."),
  synthetic: portal("Synthetic", "https://synthetic.new", "Account → Billing → manage subscription."),
  baseten: portal("Baseten", "https://app.baseten.co/settings/billing"),
  replicate: portal("Replicate", "https://replicate.com/account/billing", "Manage billing → Invoice history."),
  fal: portal("fal.ai", "https://fal.ai/dashboard/billing", "Open billing history for your account."),
  poe: portal("Poe", "https://poe.com/settings", "Manage subscription → billing history. Mobile purchases use the original store’s receipts."),
  minimax: portal("MiniMax API", "https://platform.minimax.io/user-center/payment/balance", "Account → Billing → invoices for API purchases."),
  "minimax-coding": portal("MiniMax Token Plan", "https://platform.minimax.io/user-center/payment/token-plan", "Manage your Token Plan → payment history."),
  kimi: portal("Kimi API", "https://platform.moonshot.ai", "Billing → payment history for your API account."),
  "kimi-coding": portal("Kimi Code", "https://www.kimi.com/code/console", "Manage your subscription and payment history."),
  huggingface: portal("Hugging Face", "https://huggingface.co/settings/billing/invoices"),
  abacus: portal("Abacus.AI", "https://apps.abacus.ai", "Profile → Manage subscription → invoices."),
  "qwen-coding": portal("Qwen Coding Plan", "https://usercenter2-intl.aliyun.com", "Expenses and costs → Invoices for your Coding Plan account."),
  manus: portal("Manus", "https://manus.im", "Settings → Billing → Invoice history."),
  mammouth: portal("Mammouth AI", "https://mammouth.ai", "Settings → subscription and billing portal."),
  cerebras: portal("Cerebras", "https://cloud.cerebras.ai", "Open your organization’s billing and payment history."),
};

/** Deliberate exclusions: no verified invoice destination for this connection yet, or no central vendor billing. */
export const INVOICE_UNSUPPORTED: Record<string, string> = {
  "nvidia-nim": "Hosted evaluation access; enterprise licensing is billed through the customer's vendor agreement.",
  "nvidia-pair": "Local router; no provider invoice portal.",
  "openai-compatible": "Custom endpoint does not identify a billing vendor.",
  chutes: "Subscription API found, but an invoice destination was not established.",
  "xiaomi-token-plan": "Regional invoice destination not established.",
  "xiaomi-token-plan-ams": "Regional invoice destination not established.",
  "xiaomi-token-plan-sgp": "Regional invoice destination not established.",
  orcarouter: "BYOK bills upstream; no gateway invoice destination established.",
  martian: "No public invoice destination established.",
  crofai: "No public invoice destination established.",
  inceptron: "No public invoice destination established.",
  neuralwatt: "No public invoice destination established.",
};

export function configuredInvoiceProviders(accounts: readonly Pick<Account, "provider" | "sdkProvider" | "localRuntime" | "location" | "multivibeCloud" | "email">[]): InvoiceProvider[] {
  const groups = new Map<string, InvoiceProvider>();
  for (const account of accounts) {
    if (account.multivibeCloud || account.localRuntime || account.location === "local") continue;
    const id = account.provider === "ai-sdk" ? account.sdkProvider : account.provider ?? "openai";
    const entry = id && INVOICE_PORTALS[id];
    if (!id || !entry) continue;
    let group = groups.get(id);
    if (!group) {
      group = { id, provider: id, name: entry.name, accounts: [], billingUrl: entry.url, instruction: entry.instruction, invoices: [], status: "portal" };
      groups.set(id, group);
    }
    const label = account.email || `Account ${group.accounts.length + 1}`;
    if (!group.accounts.includes(label)) group.accounts.push(label);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function invoiceDocumentUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value);
    // Invoice URLs are externally supplied. Allow Stripe's document hosts only, no credentials or arbitrary redirects.
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !["invoice.stripe.com", "pay.stripe.com", "billing.stripe.com"].includes(url.hostname)) return;
    return url.href;
  } catch { return; }
}

export function normalizeCloudInvoices(payload: unknown): Invoice[] {
  if (!payload || typeof payload !== "object") throw new Error("invalid_invoice_response");
  const data = payload as Record<string, unknown>;
  if (!Array.isArray(data.data)) throw new Error("invalid_invoice_response");
  // Only settled financial environments qualify, never shadow or Stripe test projections.
  if (data.environment !== "live" || data.financialEnvironment !== "live") return [];
  const seen = new Set<string>();
  return data.data.flatMap((value: unknown): Invoice[] => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    if (typeof row.invoiceId !== "string" || !row.invoiceId.startsWith("in_") || seen.has(row.invoiceId) || row.status === "draft") return [];
    if (row.currency !== "USD" || typeof row.amountDueMinor !== "string" || !/^\d{1,15}$/.test(row.amountDueMinor)) return [];
    seen.add(row.invoiceId);
    return [{ id: row.invoiceId, date: typeof row.observedAt === "string" && Number.isFinite(Date.parse(row.observedAt)) ? row.observedAt : undefined,
      amountMinor: row.amountDueMinor, currency: row.currency,
      status: row.paid === true ? "paid" : ["open", "void", "uncollectible"].includes(String(row.status)) ? String(row.status) : undefined,
      documentUrl: invoiceDocumentUrl(row.invoicePdfUrl) ?? invoiceDocumentUrl(row.hostedInvoiceUrl) }];
  });
}

export async function invoiceOverview(accounts: readonly Account[], cloud?: { getInvoices(): Promise<Invoice[]> }): Promise<InvoiceOverview> {
  const providers = configuredInvoiceProviders(accounts);
  const deepinfra = providers.find(provider => provider.id === "deepinfra");
  if (deepinfra) {
    // Independent account reads, bounded concurrency. One denied key must not hide another account's invoices.
    const candidates = accounts.filter(account => account.provider === "ai-sdk" && account.sdkProvider === "deepinfra" && !account.multivibeCloud && !account.localRuntime && account.location !== "local");
    const rows = new Map<string, Invoice>();
    const signal = AbortSignal.timeout(8000);
    for (let offset = 0; offset < candidates.length; offset += 3) {
      await Promise.all(candidates.slice(offset, offset + 3).map(async account => {
        try {
          const result = await deepinfraInvoices(account.accessToken, fetch, signal);
          for (const invoice of result.invoices) rows.set(invoice.id, invoice);
          deepinfra.limited ||= result.limited;
        } catch { deepinfra.status = "unavailable"; }
      }));
    }
    deepinfra.invoices = [...rows.values()].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    if (deepinfra.status !== "unavailable" && rows.size) deepinfra.status = "ready";
    deepinfra.instruction = "Download invoices below or open billing. Amounts are shown in the documents.";
  }
  let cloudUnavailable = false;
  if (cloud) {
    try {
      const invoices = await cloud.getInvoices();
      if (invoices.length) providers.unshift({ id: "multivibe-cloud", provider: "multivibe-cloud", name: "MultiVibe Cloud", accounts: [],
        billingUrl: "https://app.multivibe.cloud/billing", instruction: "Subscription and credit purchases", invoices, status: "ready", limited: invoices.length >= 100 });
    } catch { cloudUnavailable = true; }
  }
  return { providers, cloudUnavailable };
}

/** DeepInfra documents invoice totals without a currency/unit contract. Keep document links, never guess a price. */
export async function deepinfraInvoices(token: string, fetchImpl: typeof fetch = fetch, signal = AbortSignal.timeout(8000)): Promise<{ invoices: Invoice[]; limited: boolean }> {
  const invoices: Invoice[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const response = await fetchImpl(`https://api.deepinfra.com/payment/invoices?limit=50${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" }, redirect: "error", signal,
    });
    if (!response.ok) throw new Error("invoice_access_unavailable");
    const data = await response.json() as Record<string, unknown>;
    if (!Array.isArray(data.invoices) || typeof data.has_more !== "boolean") throw new Error("invalid_invoice_response");
    for (const value of data.invoices) {
      if (!value || typeof value !== "object") continue;
      const row = value as Record<string, unknown>;
      const documentUrl = invoiceDocumentUrl(row.invoice_pdf) ?? invoiceDocumentUrl(row.hosted_invoice_url);
      if (typeof row.id !== "string" || seen.has(row.id) || row.status === "draft" || !documentUrl) continue;
      seen.add(row.id);
      const date = typeof row.created === "number" && Number.isFinite(row.created) && row.created > 0 && row.created < 100000000000 ? new Date(row.created * 1000).toISOString() : undefined;
      invoices.push({ id: row.id, date, documentUrl, status: ["paid", "open", "void", "uncollectible"].includes(String(row.status)) ? String(row.status) : undefined });
    }
    if (!data.has_more) return { invoices, limited: false };
    if (typeof data.next_cursor !== "string" || !data.next_cursor || data.next_cursor === cursor || data.next_cursor.length > 500) return { invoices, limited: true };
    cursor = data.next_cursor;
  }
  return { invoices, limited: true };
}
