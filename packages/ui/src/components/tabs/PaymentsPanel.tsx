import React, { useEffect, useState } from "react";
import { Metric } from "../Metric";
import { ApiError } from "../../lib/api";
import { activeLocale, useT } from "../../i18n";
import type {
  DashboardEarnings,
  DashboardPayment,
  DashboardPaymentPack,
  DashboardPaymentsOverview,
} from "../../types";

type Api = (path: string, init?: RequestInit) => Promise<any>;
type Props = { api: Api };

type PackDraft = {
  id: string;
  label: string;
  price: string;
  credit: string;
  bonus: string;
  enabled: boolean;
};

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.message) {
      try {
        const parsed = JSON.parse(error.message) as { message?: string; error?: string };
        if (parsed.message) return parsed.message;
        if (parsed.error) return parsed.error;
      } catch {
        return error.message;
      }
    }
    return `${error.status}`;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

function priceInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

function money(cents: number | undefined, currency: string): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "—";
  const fraction = currency === "JPY" ? 0 : 2;
  return new Intl.NumberFormat(activeLocale(), {
    style: "currency",
    currency,
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction,
  }).format(cents / 100);
}

function usd(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(activeLocale(), {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function packDraft(pack: DashboardPaymentPack): PackDraft {
  return {
    id: pack.id,
    label: pack.label ?? "",
    price: priceInput(pack.amountCents),
    credit: String(pack.creditUsd),
    bonus: pack.bonusUsd ? String(pack.bonusUsd) : "",
    enabled: pack.enabled !== false,
  };
}

function packPayload(draft: PackDraft, currency: string): DashboardPaymentPack | null {
  const price = Number(draft.price.replace(",", "."));
  const credit = Number(draft.credit.replace(",", "."));
  const bonus = draft.bonus.trim() ? Number(draft.bonus.replace(",", ".")) : 0;
  if (!draft.id.trim() || !Number.isFinite(price) || !Number.isFinite(credit)) return null;
  if (!draft.bonus.trim() || Number.isFinite(bonus)) {
    return {
      id: draft.id.trim(),
      currency,
      amountCents: Math.round(price * 100),
      creditUsd: credit,
      ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
      ...(bonus > 0 ? { bonusUsd: bonus } : {}),
      ...(draft.enabled ? {} : { enabled: false }),
    };
  }
  return null;
}

const STATUS_LABEL: Record<string, string> = {
  open: "Awaiting payment",
  paid: "Paid",
  expired: "Expired",
  refunded: "Refunded",
  disputed: "Disputed",
};

/**
 * Admin marketplace panel: enroll this instance with the MultiVibe broker,
 * connect the admin's own Stripe account once, then sell credit packs.
 */
export function PaymentsPanel({ api }: Props) {
  const tr = useT();
  const [overview, setOverview] = useState<DashboardPaymentsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [currency, setCurrency] = useState("EUR");
  const [packs, setPacks] = useState<PackDraft[]>([]);
  const [enrollment, setEnrollment] = useState<{
    code: string;
    verificationUrl: string;
    expiresAt: number;
  } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = (await api("payments")) as DashboardPaymentsOverview;
      setOverview(data);
      setEnabled(data.settings.enabled === true);
      setCurrency(data.settings.currency || "EUR");
      setPacks((data.settings.packs ?? []).map(packDraft));
      // A reload must not lose a ticket that is still waiting for approval.
      setEnrollment(data.settings.pendingEnrollment ?? null);
      setError("");
    } catch (err) {
      setError(errorText(err, tr("The marketplace settings could not be loaded.")));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const returned = params.get("connect");
    if (returned) {
      setNotice(
        returned === "refresh"
          ? tr("The Stripe onboarding link expired. Start a new one from Connect Stripe.")
          : tr("Stripe onboarding finished. Refresh the status to see the new capabilities."),
      );
      const url = new URL(window.location.href);
      url.searchParams.delete("connect");
      window.history.replaceState({}, "", url.toString());
    }
    void load();
    // `load` only depends on the stable api function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settings = overview?.settings;
  const connect = settings?.connect;
  const earnings: DashboardEarnings | undefined = overview?.earnings;
  const connected = connect?.chargesEnabled === true;
  const enrolled = settings?.secretConfigured === true;

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (err) {
      setError(errorText(err, tr("The marketplace request failed.")));
    } finally {
      setBusy("");
    }
  };

  const saveSettings = async (patch: Record<string, unknown>) => {
    const response = await api("payments/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    setOverview((current) =>
      current ? { ...current, settings: { ...current.settings, ...response.settings } } : current,
    );
  };

  const startEnrollment = () =>
    run("enroll", async () => {
      const ticket = (await api("payments/enrollment", { method: "POST" })) as {
        code: string;
        verificationUrl: string;
        expiresAt: number;
      };
      setEnrollment(ticket);
      setNotice(tr("Approve this instance in the marketplace, then check the enrollment."));
    });

  const pollEnrollment = () =>
    run("poll", async () => {
      const result = (await api("payments/enrollment")) as { status: string };
      if (result.status === "enrolled") {
        setEnrollment(null);
        setNotice(tr("This instance is now connected to the marketplace."));
      } else {
        setNotice(tr("The marketplace has not approved this instance yet."));
      }
      await load();
    });

  const connectStripe = () =>
    run("connect", async () => {
      const result = (await api("payments/connect/onboarding", { method: "POST" })) as {
        url: string;
      };
      if (result.url) window.location.assign(result.url);
    });

  const refreshConnect = () =>
    run("refresh", async () => {
      await api("payments/connect?refresh=1");
      await load();
      setNotice(tr("Stripe status refreshed."));
    });

  const openDashboard = () =>
    run("dashboard", async () => {
      const result = (await api("payments/connect?loginLink=1")) as {
        connect?: { dashboardUrl?: string };
      };
      if (result.connect?.dashboardUrl) window.open(result.connect.dashboardUrl, "_blank", "noopener");
      else setNotice(tr("Stripe does not expose a dashboard link yet."));
      await load();
    });

  const sync = () =>
    run("sync", async () => {
      const result = (await api("payments/sync", { method: "POST" })) as {
        applied?: number;
        reconciled?: { credited?: number; refunded?: number };
      };
      await load();
      setNotice(
        tr("Synchronized {applied} events.", { applied: String(result.applied ?? 0) }),
      );
    });

  const disconnect = () => {
    if (!window.confirm(tr("Disconnect this instance from the marketplace? Existing wallets stay untouched."))) {
      return;
    }
    void run("disconnect", async () => {
      await api("payments/disconnect", { method: "POST" });
      await load();
      setNotice(tr("This instance is disconnected. Members can no longer buy credit."));
    });
  };

  const savePacks = () =>
    run("packs", async () => {
      const payload = packs.map((draft) => packPayload(draft, currency));
      if (payload.some((pack) => !pack)) {
        setError(tr("Every pack needs an id, a price and a credit amount."));
        return;
      }
      await saveSettings({ packs: payload, currency });
      setNotice(tr("Credit packs saved."));
    });

  const refund = (payment: DashboardPayment) => {
    const remaining = payment.amountCents - (payment.refundedCents ?? 0);
    const answer = window.prompt(
      tr("Refund amount in {currency} (blank for the full {amount}).", {
        currency: payment.currency,
        amount: money(remaining, payment.currency),
      }),
      "",
    );
    if (answer === null) return;
    const parsed = answer.trim() ? Number(answer.replace(",", ".")) : undefined;
    if (parsed !== undefined && (!Number.isFinite(parsed) || parsed <= 0)) {
      setError(tr("Enter a positive refund amount."));
      return;
    }
    void run("refund", async () => {
      await api("payments/refund", {
        method: "POST",
        body: JSON.stringify({
          paymentId: payment.paymentId,
          ...(parsed !== undefined ? { amountCents: Math.round(parsed * 100) } : {}),
        }),
      });
      await load();
      setNotice(tr("Refund registered. The member's wallet follows on the next sync."));
    });
  };

  const toggleEnabled = (next: boolean) => {
    setEnabled(next);
    void run("enabled", async () => {
      await saveSettings({ enabled: next });
      setNotice(next ? tr("Marketplace billing is on.") : tr("Marketplace billing is off."));
    });
  };

  const addPack = () => {
    setPacks((current) => [
      ...current,
      { id: `pack_${current.length + 1}`, label: "", price: "5.00", credit: "5", bonus: "", enabled: true },
    ]);
  };

  const removePack = (index: number) => {
    setPacks((current) => current.filter((_, position) => position !== index));
  };

  const updatePack = (index: number, patch: Partial<PackDraft>) => {
    setPacks((current) =>
      current.map((draft, position) => (position === index ? { ...draft, ...patch } : draft)),
    );
  };

  const connectionTone = connected
    ? "success"
    : connect?.status === "restricted"
      ? "danger"
      : "warning";
  const connectionLabel = connected
    ? tr("Active")
    : connect?.status === "restricted"
      ? tr("Restricted")
      : connect?.status === "pending"
        ? tr("Pending review")
        : tr("Stripe not connected");

  return (
    <div className="tab-stack">
      <section className="panel">
        <div className="section-split-header">
          <div>
            <h2>{tr("Marketplace billing")}</h2>
            <p className="muted">
              {tr("Sell prepaid credit and subscriptions with your own Stripe account. The marketplace keeps {rate} commission per payment.", {
                rate: `${((settings?.commissionBps ?? 500) / 100).toFixed(2)}%`,
              })}
            </p>
          </div>
          <button className="btn btn-secondary" type="button" disabled={loading} onClick={() => void load()}>
            {loading ? tr("Refreshing…") : tr("Refresh")}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {notice && <div className="notice">{notice}</div>}

        {!enrolled ? (
          <div className="compact-empty-state">
            <strong>{tr("This instance is not enrolled")}</strong>
            <span>
              {tr("Create a marketplace ticket, approve it on the marketplace site, then come back to finish the connection.")}
            </span>
            {enrollment ? (
              <div className="tab-stack">
                <p>
                  {tr("Enrollment code")}: <code>{enrollment.code}</code>
                </p>
                <p>
                  <a href={enrollment.verificationUrl} target="_blank" rel="noreferrer">
                    {tr("Open the marketplace to approve this instance")}
                  </a>
                </p>
                <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => void pollEnrollment()}>
                  {busy === "poll" ? tr("Checking…") : tr("Check enrollment")}
                </button>
              </div>
            ) : (
              <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => void startEnrollment()}>
                {busy === "enroll" ? tr("Starting…") : tr("Enroll this instance")}
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="overview-metrics">
              <Metric
                title={tr("Connection")}
                value={connectionLabel}
                detail={connect?.accountId ?? tr("No Stripe account yet")}
                tone={connectionTone}
              />
              <Metric
                title={tr("Instance")}
                value={settings?.instanceId ?? "—"}
                detail={settings?.brokerUrl ?? "—"}
              />
              <Metric
                title={tr("Commission")}
                value={`${((settings?.commissionBps ?? 0) / 100).toFixed(2)}%`}
                detail={tr("Snapshotted on every payment")}
              />
              <Metric
                title={tr("Charges & payouts")}
                value={connect?.chargesEnabled ? tr("Enabled") : tr("Disabled")}
                detail={connect?.payoutsEnabled ? tr("Payouts enabled") : tr("Payouts not enabled yet")}
                tone={connect?.chargesEnabled ? "success" : "warning"}
              />
            </div>

            {connect?.requirementsDue?.length ? (
              <div className="error">
                {tr("Stripe still needs: {items}", { items: connect.requirementsDue.join(", ") })}
              </div>
            ) : null}

            <div className="inline wrap">
              <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => void connectStripe()}>
                {connect?.accountId ? tr("Continue Stripe onboarding") : tr("Connect Stripe")}
              </button>
              <button className="btn btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void refreshConnect()}>
                {tr("Refresh Stripe status")}
              </button>
              <button className="btn btn-secondary" type="button" disabled={Boolean(busy) || !connected} onClick={() => void openDashboard()}>
                {tr("Open Stripe dashboard")}
              </button>
              <button className="btn btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void sync()}>
                {busy === "sync" ? tr("Synchronizing…") : tr("Sync payments now")}
              </button>
              <button className="btn danger" type="button" disabled={Boolean(busy)} onClick={disconnect}>
                {tr("Disconnect")}
              </button>
            </div>
          </>
        )}
      </section>

      {enrolled ? (
        <section className="panel">
          <div className="section-split-header">
            <div>
              <h2>{tr("Marketplace settings")}</h2>
              <p className="muted">
                {tr("Members see these packs on their Credit page once Stripe accepts charges.")}
              </p>
            </div>
            <label className="control-field">
              <span className="control-label">{tr("Billing enabled")}</span>
              <input
                type="checkbox"
                checked={enabled}
                disabled={Boolean(busy)}
                onChange={(event) => toggleEnabled(event.target.checked)}
              />
            </label>
          </div>

          <div className="form-grid">
            <label className="control-field">
              <span className="control-label">{tr("Currency")}</span>
              <input
                value={currency}
                maxLength={3}
                disabled={Boolean(busy)}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                onBlur={() => {
                  const next = currency.trim().toUpperCase();
                  if (/^[A-Z]{3}$/.test(next)) setCurrency(next);
                }}
              />
              <span className="field-help">{tr("Prices are charged in this currency by your Stripe account.")}</span>
            </label>
          </div>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{tr("Pack id")}</th>
                  <th>{tr("Label")}</th>
                  <th>{tr("Price")}</th>
                  <th>{tr("Credit (USD)")}</th>
                  <th>{tr("Bonus (USD)")}</th>
                  <th>{tr("Enabled")}</th>
                  <th aria-label={tr("Actions")} />
                </tr>
              </thead>
              <tbody>
                {packs.map((draft, index) => (
                  <tr key={index}>
                    <td>
                      <input
                        value={draft.id}
                        disabled={Boolean(busy)}
                        onChange={(event) => updatePack(index, { id: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        value={draft.label}
                        placeholder={tr("Optional")}
                        disabled={Boolean(busy)}
                        onChange={(event) => updatePack(index, { label: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        inputMode="decimal"
                        value={draft.price}
                        disabled={Boolean(busy)}
                        onChange={(event) => updatePack(index, { price: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        inputMode="decimal"
                        value={draft.credit}
                        disabled={Boolean(busy)}
                        onChange={(event) => updatePack(index, { credit: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        inputMode="decimal"
                        value={draft.bonus}
                        disabled={Boolean(busy)}
                        onChange={(event) => updatePack(index, { bonus: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        disabled={Boolean(busy)}
                        onChange={(event) => updatePack(index, { enabled: event.target.checked })}
                      />
                    </td>
                    <td>
                      <button className="btn ghost" type="button" disabled={Boolean(busy)} onClick={() => removePack(index)}>
                        {tr("Remove")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="inline wrap">
            <button className="btn btn-secondary" type="button" disabled={Boolean(busy)} onClick={addPack}>
              {tr("Add pack")}
            </button>
            <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => void savePacks()}>
              {busy === "packs" ? tr("Saving…") : tr("Save packs")}
            </button>
          </div>
        </section>
      ) : null}

      {enrolled && connected ? (
        <section className="panel">
          <div className="section-split-header">
            <div>
              <h2>{tr("Earnings")}</h2>
              <p className="muted">
                {tr("What your Stripe account keeps after the marketplace commission and refunds.")}
              </p>
            </div>
          </div>
          <div className="overview-metrics">
            <Metric
              title={tr("Gross")}
              value={money(earnings?.grossCents, earnings?.currency ?? currency)}
              detail={tr("{count} paid checkouts", { count: String(earnings?.paidCount ?? 0) })}
            />
            <Metric
              title={tr("Commission")}
              value={money(earnings?.feeCents, earnings?.currency ?? currency)}
              detail={tr("Paid to the marketplace")}
            />
            <Metric
              title={tr("Refunded")}
              value={money(earnings?.refundedCents, earnings?.currency ?? currency)}
              detail={tr("Returned to members")}
            />
            <Metric
              title={tr("Net")}
              value={money(earnings?.netCents, earnings?.currency ?? currency)}
              detail={tr("Before Stripe fees")}
            />
          </div>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{tr("Date")}</th>
                  <th>{tr("Member")}</th>
                  <th>{tr("Amount")}</th>
                  <th>{tr("Credit")}</th>
                  <th>{tr("Status")}</th>
                  <th aria-label={tr("Actions")} />
                </tr>
              </thead>
              <tbody>
                {(overview?.payments ?? []).map((payment) => (
                  <tr key={payment.paymentId}>
                    <td>{new Date(payment.createdAt).toLocaleString(activeLocale())}</td>
                    <td>{payment.userRef}</td>
                    <td>{money(payment.amountCents, payment.currency)}</td>
                    <td>{usd(payment.creditUsd)}</td>
                    <td>{tr(STATUS_LABEL[payment.status] ?? payment.status)}</td>
                    <td>
                      {payment.status === "paid" ? (
                        <button className="btn ghost" type="button" disabled={Boolean(busy)} onClick={() => refund(payment)}>
                          {tr("Refund")}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {(overview?.payments ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted">
                      {tr("No payments yet.")}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
