import type { InvoiceOverview } from "../../../../src/provider-invoices";
import { ProviderMark } from "../ProviderPicker";
import "./InvoicesTab.css";

export function InvoicesTab({ overview, loading, error, onRefresh, sanitized = false }: {
  sanitized?: boolean; overview: InvoiceOverview; loading: boolean; error: string; onRefresh: () => void;
}) {
  return <section className="invoices-page" aria-labelledby="invoices-title" aria-busy={loading}>
    <header className="invoices-heading"><div><h1 id="invoices-title">Invoices</h1><p>Subscriptions and API purchases</p></div>
      <button className="btn secondary" disabled={loading} onClick={onRefresh}>{loading ? "Refreshing…" : "Refresh"}</button>
    </header>
    {error && <p className="invoice-notice" role="alert">{error}</p>}
    {overview.cloudUnavailable && <p className="invoice-notice" role="status">MultiVibe Cloud invoices could not be checked. Try refreshing.</p>}
    {!loading && !overview.providers.length && !error && <p className="invoice-notice">No invoice sources available for your connected providers.</p>}
    {overview.providers.map(provider => <article className="invoice-provider" key={provider.id}>
      <header className="invoice-provider-heading">
        <ProviderMark provider="ai-sdk" sdkProvider={provider.provider} name={provider.name} />
        <div className="invoice-provider-title"><h2>{provider.name}</h2>{provider.accounts.length > 0 && <p>{sanitized ? `${provider.accounts.length} connected account${provider.accounts.length > 1 ? "s" : ""}` : provider.accounts.join(" · ")}</p>}</div>
        <a className="btn secondary" href={provider.billingUrl} target="_blank" rel="noopener noreferrer">Open billing <span aria-hidden="true">↗</span></a>
      </header>
      <p className="invoice-instruction">{provider.instruction}</p>
      {provider.status === "unavailable" && <p className="invoice-notice" role="status">Some invoices could not be loaded with this connection. Use the billing link to see all invoices.</p>}
      {provider.invoices.length > 0 && <div className="invoice-table-scroll"><table className="invoice-table">
        <thead><tr><th scope="col">Date</th><th scope="col">Invoice</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Document</span></th></tr></thead>
        <tbody>{provider.invoices.map(invoice => <tr key={invoice.id}>
          <td>{invoice.date ? new Date(invoice.date).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—"}</td>
          <td><span className="invoice-reference" title={invoice.id}>{invoice.id}</span></td>
          <td className="invoice-amount">{invoice.amountMinor !== undefined && invoice.currency ? new Intl.NumberFormat(undefined, { style: "currency", currency: invoice.currency }).format(Number(invoice.amountMinor) / 100) : <span className="invoice-muted">See invoice</span>}</td>
          <td><span className={`invoice-status ${invoice.status === "paid" ? "is-paid" : ""}`}>{invoice.status ?? "—"}</span></td>
          <td><a href={invoice.documentUrl ?? provider.billingUrl} target="_blank" rel="noopener noreferrer" aria-label={`${invoice.documentUrl ? "View invoice" : "Open billing for invoice"} ${invoice.id}`}>{invoice.documentUrl ? "View invoice" : "Open billing"} <span aria-hidden="true">↗</span></a></td>
        </tr>)}</tbody>
      </table></div>}
      {provider.limited && <p className="invoice-instruction">Recent invoices shown. Open billing for the full history.</p>}
    </article>)}
    {overview.providers.length > 0 && <p className="invoice-footer">Billing pages open in a new tab. Sign in with the account shown above.</p>}
  </section>;
}
