import { MULTIVIBE_CLOUD_API_BASE_URL } from "../config.js";
import type {
  NotificationEvent,
  NotificationPayloads,
  RenderedEmail,
} from "./types.js";

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape every interpolated value before it enters an HTML or attribute context. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/** Amounts are always USD, formatted the same way in every locale. */
export function formatUsd(value: number): string {
  return USD_FORMATTER.format(Number.isFinite(value) ? value : 0);
}

/** Collapse control characters/newlines so a value cannot forge a header or line. */
function plainText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
}

/** Only absolute http(s) links are allowed in CTA buttons. */
function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return undefined;
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function appBaseUrl(value: string): string {
  const safe = safeHttpUrl(value) ?? MULTIVIBE_CLOUD_API_BASE_URL;
  return safe.replace(/\/+$/, "");
}

function greeting(recipientName: string | undefined): string {
  const name = plainText(recipientName);
  return name ? `Hi ${name},` : "Hi,";
}

function billingUrl(context: TemplateContext, override: unknown): string {
  return safeHttpUrl(override) ?? `${appBaseUrl(context.appUrl)}/billing`;
}

type TemplateContext = {
  recipientName?: string;
  appUrl: string;
};

type DetailRow = { label: string; value: string };

type TemplateOutput = {
  subject: string;
  preheader: string;
  heading: string;
  intro: string;
  details: DetailRow[];
  ctaLabel: string;
  ctaUrl: string;
  footerNote?: string;
};

const TEMPLATES: {
  [K in keyof NotificationPayloads]: (
    data: NotificationPayloads[K],
    context: TemplateContext,
  ) => TemplateOutput;
} = {
  balance_low: (data, context) => {
    const balance = formatUsd(data.balanceUsd);
    const details: DetailRow[] = [{ label: "Current balance", value: balance }];
    if (Number.isFinite(data.thresholdUsd)) {
      details.push({
        label: "Low-balance threshold",
        value: formatUsd(data.thresholdUsd ?? 0),
      });
    }
    return {
      subject: "Your MultiVibe balance is low",
      preheader: `Your MultiVibe balance is ${balance}. Add credit to keep requests running.`,
      heading: "Your balance is running low",
      intro: `${greeting(context.recipientName)} your prepaid MultiVibe balance is ${balance}. Add credit to keep your requests running without interruption.`,
      details,
      ctaLabel: "Add credit",
      ctaUrl: billingUrl(context, data.ctaUrl),
    };
  },
  topup_succeeded: (data, context) => {
    const amount = formatUsd(data.amountUsd);
    const details: DetailRow[] = [{ label: "Amount added", value: amount }];
    if (Number.isFinite(data.balanceUsd)) {
      details.push({
        label: "New balance",
        value: formatUsd(data.balanceUsd ?? 0),
      });
    }
    return {
      subject: "Your MultiVibe top-up succeeded",
      preheader: `${amount} was added to your MultiVibe balance.`,
      heading: "Top-up confirmed",
      intro: `${greeting(context.recipientName)} ${amount} was added to your MultiVibe balance. You can keep using MultiVibe right away.`,
      details,
      ctaLabel: "View billing",
      ctaUrl: billingUrl(context, data.ctaUrl),
    };
  },
  spend_limit_reached: (data, context) => {
    const limit = formatUsd(data.limitUsd);
    const period = plainText(data.periodLabel);
    const details: DetailRow[] = [{ label: "Spend limit", value: limit }];
    if (Number.isFinite(data.spentUsd)) {
      details.push({
        label: "Amount spent",
        value: formatUsd(data.spentUsd ?? 0),
      });
    }
    if (period) details.push({ label: "Period", value: period });
    return {
      subject: "You reached your MultiVibe spend limit",
      preheader: `Your MultiVibe spending reached the ${limit} limit${period ? ` for ${period}` : ""}.`,
      heading: "Spend limit reached",
      intro: `${greeting(context.recipientName)} your MultiVibe spending reached the ${limit} limit${period ? ` for ${period}` : ""}. Add credit or review your billing settings to keep using MultiVibe.`,
      details,
      ctaLabel: "Review billing",
      ctaUrl: billingUrl(context, data.ctaUrl),
    };
  },
};

function buildTemplate(
  event: NotificationEvent,
  context: TemplateContext,
): TemplateOutput {
  switch (event.type) {
    case "balance_low":
      return TEMPLATES.balance_low(event.data, context);
    case "topup_succeeded":
      return TEMPLATES.topup_succeeded(event.data, context);
    case "spend_limit_reached":
      return TEMPLATES.spend_limit_reached(event.data, context);
    default: {
      // Compile-time exhaustiveness gate for newly added event types.
      const exhaustive: never = event;
      void exhaustive;
      const unsupported = event as { type?: string };
      throw new Error(
        `unsupported notification event: ${unsupported.type ?? "unknown"}`,
      );
    }
  }
}

function renderHtml(output: TemplateOutput): string {
  const details = output.details
    .map(
      (detail) => `<tr>
  <td style="padding:10px 0;border-bottom:1px solid #2c3930;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;color:#91a59f;">${escapeHtml(detail.label)}</td>
  <td align="right" style="padding:10px 0;border-bottom:1px solid #2c3930;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;color:#edf5f2;font-weight:700;">${escapeHtml(detail.value)}</td>
</tr>`,
    )
    .join("");
  const detailsBlock = details
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0;">${details}</table>`
    : "";
  const footerNote = output.footerNote
    ? `<p style="margin:0 0 8px;">${escapeHtml(output.footerNote)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(output.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#0b1210;">
<span style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(output.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0b1210;">
<tr>
<td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#141d19;border:1px solid #2c3930;border-radius:16px;">
<tr>
<td style="padding:28px 32px 0;">
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:22px;line-height:28px;font-weight:800;letter-spacing:-0.02em;color:#edf5f2;">Multi<span style="color:#72f7b9;">Vibe</span></div>
</td>
</tr>
<tr>
<td style="padding:24px 32px 0;">
<h1 style="margin:0 0 14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:24px;line-height:32px;font-weight:800;letter-spacing:-0.02em;color:#edf5f2;">${escapeHtml(output.heading)}</h1>
<p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:24px;color:#c2d1cc;">${escapeHtml(output.intro)}</p>
${detailsBlock}
</td>
</tr>
<tr>
<td style="padding:28px 32px 8px;">
<a href="${escapeHtml(output.ctaUrl)}" style="display:inline-block;background-color:#72f7b9;color:#091411;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:20px;font-weight:700;padding:13px 22px;border-radius:10px;">${escapeHtml(output.ctaLabel)}</a>
</td>
</tr>
<tr>
<td style="padding:24px 32px 28px;border-top:1px solid #2c3930;">
${footerNote}
<p style="margin:0 0 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#91a59f;">You are receiving this email because you have a MultiVibe account.</p>
<p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#91a59f;">MultiVibe</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

function renderText(output: TemplateOutput): string {
  const lines = ["MultiVibe", "", output.heading, "", output.intro];
  if (output.details.length) {
    lines.push("");
    for (const detail of output.details) {
      lines.push(`${plainText(detail.label)}: ${plainText(detail.value)}`);
    }
  }
  lines.push("", `${plainText(output.ctaLabel)}: ${output.ctaUrl}`);
  if (output.footerNote) lines.push("", plainText(output.footerNote));
  lines.push(
    "",
    "You are receiving this email because you have a MultiVibe account.",
    "MultiVibe",
  );
  return lines.join("\n");
}

export type RenderNotificationOptions = {
  recipientName?: string;
  /** Dashboard base URL used for the CTA; defaults to MULTIVIBE_CLOUD_API_BASE_URL. */
  appUrl?: string;
};

/** Render both alternatives for an event. Pure, synchronous and testable. */
export function renderNotification(
  event: NotificationEvent,
  options: RenderNotificationOptions = {},
): RenderedEmail {
  const output = buildTemplate(event, {
    recipientName: options.recipientName,
    appUrl: options.appUrl ?? MULTIVIBE_CLOUD_API_BASE_URL,
  });
  return {
    subject: output.subject,
    html: renderHtml(output),
    text: renderText(output),
  };
}
