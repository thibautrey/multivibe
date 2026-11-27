import { activeLocale, useT } from "../../i18n";
import { invoiceStatusLabel, type InvoiceOverview } from "../../domain/provider-invoices";
import type { DashboardPayment } from "../../types";
import { ProviderMark } from "../ProviderPicker";
import "./InvoicesTab.css";

function purchaseStatusLabel(t: (key: string) => string, status: DashboardPayment["status"]): string {
  if (status === "paid") return t("Paid in full");
  if (status === "open") return t("Awaiting payment");
  if (status === "expired") return t("Expired");
  if (status === "refunded") return t("Refunded");
  return t("Disputed");
}

function purchaseAmount(payment: DashboardPayment): string {
  return new Intl.NumberFormat(activeLocale(), {
    style: "currency",
    currency: payment.currency,
  }).format(payment.amountCents / 100);
}

export function InvoicesTab({ overview, loading, error, onRefresh, sanitized = false, purchases, onOpenCredit }: {
  sanitized?: boolean; overview: InvoiceOverview; loading: boolean; error: string; onRefresh: () => void;
  /** Member purchases made through the instance's Stripe marketplace. */
  purchases?: DashboardPayment[];
  onOpenCredit?: () => void;
}) {
  const t = useT();
  return <section className="invoices-page" aria-labelledby="invoices-title" aria-busy={loading}>
    <header className="invoices-heading"><div><h1 id="invoices-title">{t("Invoices")}</h1><p>{purchases ? t("Your purchases and their Stripe invoices") : t("Subscriptions and API purchases")}</p></div>
      <button className="btn secondary" disabled={loading} onClick={onRefresh}>{loading ? t("Refreshing…") : t("Refresh")}</button>
    </header>
    {error && <p className="invoice-notice" role="alert">{error}</p>}
    {overview.cloudUnavailable && <p className="invoice-notice" role="status">{t("MultiVibe Cloud invoices could not be checked. Try refreshing.")}</p>}
    {purchases && <article className="invoice-provider invoice-purchases">
      <header className="invoice-provider-heading">
        <img className="invoice-purchases-mark" src="/assets/brand/multivibe-app-icon.svg" alt="" />
        <div className="invoice-provider-title">
          <h2>{t("Your MultiVibe purchases")}</h2>
          <p>{t("Credit bought on this instance. Stripe hosts the invoices.")}</p>
        </div>
        {onOpenCredit && <button className="btn secondary" onClick={onOpenCredit}>{t("Buy credit")}</button>}
      </header>
      {purchases.length > 0 ? <div className="invoice-table-scroll"><table className="invoice-table">
        <thead><tr><th scope="col">{t("Date")}</th><th scope="col">{t("Reference")}</th><th scope="col">{t("Amount")}</th><th scope="col">{t("Status")}</th><th scope="col"><span className="sr-only">{t("Document")}</span></th></tr></thead>
        <tbody>{purchases.map(payment => <tr key={payment.paymentId}>
          <td>{new Date(payment.paidAt ?? payment.createdAt).toLocaleDateString(activeLocale(), { day: "numeric", month: "short", year: "numeric" })}</td>
          <td><span className="invoice-reference" title={payment.paymentId}>{payment.paymentId}</span></td>
          <td className="invoice-amount">{purchaseAmount(payment)}</td>
          <td><span className={`invoice-status ${payment.status === "paid" ? "is-paid" : ""}`}>{purchaseStatusLabel(t, payment.status)}</span></td>
          <td>{payment.invoiceUrl
            ? <a href={payment.invoiceUrl} target="_blank" rel="noopener noreferrer" aria-label={t("View Stripe invoice for {id}", { id: payment.paymentId })}>{t("View invoice")} <span aria-hidden="true">↗</span></a>
            : <span className="invoice-muted">{payment.status === "paid" ? t("Receipt by email") : "—"}</span>}</td>
        </tr>)}</tbody>
      </table></div> : !loading && <p className="invoice-instruction">{t("No purchases yet. Credit you buy will appear here with its Stripe invoice.")}</p>}
    </article>}
    {!purchases && !loading && !overview.providers.length && !error && <p className="invoice-notice">{t("No invoice sources available for your connected providers.")}</p>}
    {overview.providers.map(provider => <article className="invoice-provider" key={provider.id}>
      <header className="invoice-provider-heading">
        <ProviderMark provider="ai-sdk" sdkProvider={provider.provider} name={provider.name} />
        <div className="invoice-provider-title"><h2>{t(provider.name)}</h2>{provider.accounts.length > 0 && <p>{sanitized ? (provider.accounts.length === 1 ? t("1 connected account") : t("{count} connected accounts", { count: provider.accounts.length })) : provider.accounts.join(" · ")}</p>}</div>
        <a className="btn secondary" href={provider.billingUrl} target="_blank" rel="noopener noreferrer">{t("Open billing")} <span aria-hidden="true">↗</span></a>
      </header>
      <p className="invoice-instruction">{t(provider.instruction)}</p>
      {provider.status === "unavailable" && <p className="invoice-notice" role="status">{t("Some invoices could not be loaded with this connection. Use the billing link to see all invoices.")}</p>}
      {provider.invoices.length > 0 && <div className="invoice-table-scroll"><table className="invoice-table">
        <thead><tr><th scope="col">{t("Date")}</th><th scope="col">{t("Invoice")}</th><th scope="col">{t("Amount")}</th><th scope="col">{t("Status")}</th><th scope="col"><span className="sr-only">{t("Document")}</span></th></tr></thead>
        <tbody>{provider.invoices.map(invoice => <tr key={invoice.id}>
          <td>{invoice.date ? new Date(invoice.date).toLocaleDateString(activeLocale(), { day: "numeric", month: "short", year: "numeric" }) : "—"}</td>
          <td><span className="invoice-reference" title={invoice.id}>{invoice.id}</span></td>
          <td className="invoice-amount">{invoice.amountMinor !== undefined && invoice.currency ? new Intl.NumberFormat(activeLocale(), { style: "currency", currency: invoice.currency }).format(Number(invoice.amountMinor) / 100) : <span className="invoice-muted">{t("See invoice")}</span>}</td>
          <td><span className={`invoice-status ${invoice.status === "paid" ? "is-paid" : ""}`}>{invoiceStatusLabel(invoice.status)}</span></td>
          <td><a href={invoice.documentUrl ?? provider.billingUrl} target="_blank" rel="noopener noreferrer" aria-label={t(invoice.documentUrl ? "View invoice {id}" : "Open billing for invoice {id}", { id: invoice.id })}>{t(invoice.documentUrl ? "View invoice" : "Open billing")} <span aria-hidden="true">↗</span></a></td>
        </tr>)}</tbody>
      </table></div>}
      {provider.limited && <p className="invoice-instruction">{t("Recent invoices shown. Open billing for the full history.")}</p>}
    </article>)}
    {purchases && <p className="invoice-footer">{t("Stripe invoices open in a new tab.")}</p>}
    {overview.providers.length > 0 && <p className="invoice-footer">{t("Billing pages open in a new tab. Sign in with the account shown above.")}</p>}
  </section>;
}
