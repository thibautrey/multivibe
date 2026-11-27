import React, { useEffect, useRef, useState } from "react";
import { Metric } from "../Metric";
import { ApiError } from "../../lib/api";
import { activeLocale, useT } from "../../i18n";
import type {
  DashboardMemberBilling,
  DashboardPayment,
  DashboardPaymentPack,
  DashboardSession,
  DashboardUser,
  DashboardUserQuotaWindowState,
} from "../../types";

type Api = (path: string, init?: RequestInit) => Promise<any>;

type Props = { api: Api };

function money(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const formatted = new Intl.NumberFormat(activeLocale(), {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1 ? 2 : 4,
  }).format(value);
  return formatted;
}

function count(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString(activeLocale())
    : "0";
}

function price(cents: number | undefined, currency: string): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "—";
  const fraction = currency === "JPY" ? 0 : 2;
  return new Intl.NumberFormat(activeLocale(), {
    style: "currency",
    currency,
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction,
  }).format(cents / 100);
}

function billingError(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.message) {
    try {
      const parsed = JSON.parse(error.message) as { message?: string };
      if (parsed.message) return parsed.message;
    } catch {
      return error.message;
    }
    return error.message;
  }
  return fallback;
}

function paymentStatus(tr: (key: string) => string, payment: DashboardPayment): string {
  if (payment.status === "paid") return tr("Paid");
  if (payment.status === "open") return tr("Awaiting payment");
  if (payment.status === "expired") return tr("Expired");
  if (payment.status === "refunded") return tr("Refunded");
  return tr("Disputed");
}

function windowProgress(window: DashboardUserQuotaWindowState): number | undefined {
  const ratios: number[] = [];
  if (typeof window.creditUsd === "number" && window.creditUsd > 0) {
    ratios.push(window.usage.costUsd / window.creditUsd);
  }
  if (typeof window.maxTokens === "number" && window.maxTokens > 0) {
    ratios.push(window.usage.tokens / window.maxTokens);
  }
  if (typeof window.maxRequests === "number" && window.maxRequests > 0) {
    ratios.push(window.usage.requests / window.maxRequests);
  }
  if (ratios.length === 0) return undefined;
  return Math.min(100, Math.max(0, Math.round(Math.max(...ratios) * 100)));
}

export function BillingTab({ api }: Props) {
  const tr = useT();
  const [user, setUser] = useState<DashboardUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [billing, setBilling] = useState<DashboardMemberBilling | null>(null);
  const [paying, setPaying] = useState("");
  const [notice, setNotice] = useState("");
  const [checkingReturn, setCheckingReturn] = useState(false);
  const returnHandled = useRef(false);

  const refresh = async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const session = (await api("me", signal ? { signal } : undefined)) as DashboardSession;
      setUser(session.user ?? null);
      setError("");
    } catch (err) {
      if (signal?.aborted) return;
      setError(
        err instanceof ApiError && err.message
          ? err.message
          : tr("Your billing details could not be loaded."),
      );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  const loadBilling = async (signal?: AbortSignal) => {
    try {
      const data = (await api("billing", signal ? { signal } : undefined)) as DashboardMemberBilling;
      setBilling(data);
    } catch {
      // Token sessions and instances without the marketplace simply have no
      // top-up panel; the balance above still comes from `/me`.
      if (!signal?.aborted) setBilling(null);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    void loadBilling(controller.signal);
    return () => controller.abort();
    // `refresh` is intentionally stable for the initial load only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stripe returns to `/?tab=billing&checkout=success&session_id=...`. The
  // redirect is never trusted: the server checks the session with the broker
  // and credits through the same idempotent path as the outbox.
  useEffect(() => {
    if (returnHandled.current) return;
    returnHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("checkout");
    const sessionId = params.get("session_id");
    const clean = () => {
      const url = new URL(window.location.href);
      url.searchParams.delete("checkout");
      url.searchParams.delete("session_id");
      window.history.replaceState({}, "", url.toString());
    };
    if (outcome === "cancelled") {
      setNotice(tr("Checkout cancelled: you have not been charged."));
      clean();
      return;
    }
    if (outcome !== "success" || !sessionId) return;
    setCheckingReturn(true);
    void (async () => {
      try {
        const result = (await api(
          `billing/return?session_id=${encodeURIComponent(sessionId)}`,
        )) as { payment: DashboardPayment; walletUsd: number };
        setNotice(
          result.payment.status === "paid"
            ? tr("Payment received: your prepaid balance has been credited.")
            : tr("Payment is still being confirmed by Stripe. It will appear here shortly."),
        );
        await refresh();
        await loadBilling();
      } catch {
        setNotice(tr("The payment could not be confirmed yet. Refresh in a moment."));
      } finally {
        setCheckingReturn(false);
        clean();
      }
    })();
    // The return query is read once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buy = async (pack: DashboardPaymentPack) => {
    setPaying(pack.id);
    setError("");
    try {
      const result = (await api("billing/checkout", {
        method: "POST",
        body: JSON.stringify({ packId: pack.id }),
      })) as { url: string };
      if (result.url) window.location.assign(result.url);
    } catch (err) {
      setError(billingError(err, tr("Checkout could not be started.")));
      setPaying("");
    }
  };

  const windowStates = user?.quotaWindows ?? [];
  const planWindows = user?.plan?.mode === "subscription" ? user.plan.windows ?? [] : [];
  const remaining = user?.usage.remainingCreditUsd;
  const wallet = user?.walletUsd;
  const unlimited = user ? remaining === undefined && wallet === undefined : false;

  return (
    <div className="tab-stack">
      <section className="panel">
        <div className="section-split-header">
          <div>
            <h2>{tr("Credit & usage")}</h2>
            <p className="muted">
              {tr("Your prepaid balance and what is left in the current period. Only you can see this page.")}
            </p>
          </div>
          <button
            className="btn btn-secondary"
            type="button"
            disabled={loading}
            onClick={() => {
              void refresh();
              void loadBilling();
            }}
          >
            {loading ? tr("Refreshing…") : tr("Refresh")}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {!user && !loading && !error ? (
          <div className="compact-empty-state">
            <strong>{tr("No member account in this session")}</strong>
            <span>
              {tr("Sign in with your own account to see your prepaid balance. Admins manage balances from the Users tab.")}
            </span>
          </div>
        ) : null}
        {user && unlimited ? (
          <p className="muted">
            {tr("This instance does not cap your credit: requests are metered but never blocked on balance.")}
          </p>
        ) : null}
        {user && !unlimited && remaining === 0 ? (
          <div className="error">
            {tr("Your credit is exhausted: new requests are refused until your administrator adds credit or a new period starts.")}
          </div>
        ) : null}
      </section>

      {notice ? <div className="notice">{notice}</div> : null}
      {checkingReturn ? (
        <div className="notice">{tr("Confirming your payment with Stripe…")}</div>
      ) : null}

      {billing?.enabled && billing.connected ? (
        <section className="panel">
          <div className="section-split-header">
            <div>
              <h2>{tr("Buy credit")}</h2>
              <p className="muted">
                {tr("Pay by card and the credit lands in your prepaid balance, which carries over between periods.")}
              </p>
            </div>
          </div>
          {billing.packs.length === 0 ? (
            <p className="muted">{tr("No credit pack is available right now.")}</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{tr("Pack")}</th>
                    <th>{tr("Price")}</th>
                    <th>{tr("Credit")}</th>
                    <th>{tr("Bonus")}</th>
                    <th aria-label={tr("Actions")} />
                  </tr>
                </thead>
                <tbody>
                  {billing.packs.map((pack) => (
                    <tr key={pack.id}>
                      <td>{pack.label || tr("{amount} of credit", { amount: money(pack.creditUsd) })}</td>
                      <td>{price(pack.amountCents, pack.currency || billing.currency)}</td>
                      <td>{money(pack.creditUsd)}</td>
                      <td>{pack.bonusUsd ? money(pack.bonusUsd) : "—"}</td>
                      <td>
                        <button
                          className="btn"
                          type="button"
                          disabled={Boolean(paying)}
                          onClick={() => void buy(pack)}
                        >
                          {paying === pack.id ? tr("Redirecting…") : tr("Buy")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted">
            {tr("Payments are handled by Stripe on behalf of this instance. The card statement shows the instance's Stripe account.")}
          </p>
        </section>
      ) : null}

      {billing?.enabled && !billing.connected ? (
        <div className="notice">
          {tr("Your administrator is still finishing the Stripe connection: buying credit will open once charges are enabled.")}
        </div>
      ) : null}

      {user && !unlimited ? (
        <div className="overview-metrics" aria-label={tr("Billing summary")}>
          <Metric
            loading={loading}
            preserveValueWhileLoading
            title={tr("Available credit")}
            value={money(remaining)}
            detail={tr("Period allowance plus prepaid balance")}
          />
          <Metric
            loading={loading}
            preserveValueWhileLoading
            title={tr("Prepaid balance")}
            value={money(wallet ?? 0)}
            detail={
              typeof wallet === "number" && wallet < 0
                ? tr("Negative balance, settled by the next top-up.")
                : tr("Carries over between periods")
            }
            tone={typeof wallet === "number" && wallet < 0 ? "danger" : typeof wallet === "number" && wallet <= 0 ? "warning" : "default"}
          />
          <Metric
            loading={loading}
            preserveValueWhileLoading
            title={tr("Spent this period")}
            value={money(user.usage.costUsd)}
            detail={tr("Metered at the prices set by your admin")}
          />
          <Metric
            loading={loading}
            preserveValueWhileLoading
            title={tr("Requests")}
            value={count(user.usage.requests)}
            detail={tr("{tokens} tokens", { tokens: count(user.usage.tokens) })}
          />
        </div>
      ) : null}

      {user && !unlimited && user.quota.creditUsd !== undefined ? (
        <section className="panel">
          <div className="section-split-header">
            <div>
              <h2>{tr("Period allowance")}</h2>
              <p className="muted">
                {tr("The allowance is consumed before your prepaid balance.")}
              </p>
            </div>
          </div>
          <div className="progress-stat">
            <div className="progress-head">
              <span>{tr("Spent")}</span>
              <span>
                {money(user.usage.costUsd)} / {money(user.quota.creditUsd)}
              </span>
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                user.quota.creditUsd > 0
                  ? Math.min(100, Math.round((user.usage.costUsd / user.quota.creditUsd) * 100))
                  : 100
              }
            >
              <div
                className="progress-fill"
                style={{
                  width: `${
                    user.quota.creditUsd > 0
                      ? Math.min(100, Math.round((user.usage.costUsd / user.quota.creditUsd) * 100))
                      : 100
                  }%`,
                }}
              />
            </div>
            <small>
              {tr("Resets {period}.", {
                period: user.quota.period === "day" ? tr("daily") : user.quota.period === "total" ? tr("never") : tr("monthly"),
              })}
            </small>
          </div>
        </section>
      ) : null}

      {billing && billing.payments.length > 0 ? (
        <section className="panel">
          <div className="section-split-header">
            <div>
              <h2>{tr("Payment history")}</h2>
              <p className="muted">{tr("Only you can see the payments made for your account.")}</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{tr("Date")}</th>
                  <th>{tr("Amount")}</th>
                  <th>{tr("Credit")}</th>
                  <th>{tr("Status")}</th>
                </tr>
              </thead>
              <tbody>
                {billing.payments.map((payment) => (
                  <tr key={payment.paymentId}>
                    <td>{new Date(payment.createdAt).toLocaleString(activeLocale())}</td>
                    <td>{price(payment.amountCents, payment.currency)}</td>
                    <td>{money(payment.creditUsd)}</td>
                    <td>{paymentStatus(tr, payment)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {user && planWindows.length > 0 ? (
        <section className="panel">
          <div className="section-split-header">
            <div>
              <h2>{user.plan?.name || tr("Subscription")}</h2>
              <p className="muted">
                {typeof user.plan?.priceUsd === "number"
                  ? tr("{amount} per period", { amount: money(user.plan.priceUsd) })
                  : tr("Rolling limits for this subscription.")}
              </p>
            </div>
          </div>
          <div className="tab-stack">
            {planWindows.map((window) => {
              const state = windowStates.find((candidate) => candidate.id === window.id);
              const progress = state ? windowProgress(state) : undefined;
              const label =
                window.label ||
                (window.period === "5h"
                  ? tr("5 hours")
                  : window.period === "day"
                    ? tr("Daily")
                    : window.period === "week"
                      ? tr("Weekly")
                      : tr("Monthly"));
              return (
                <div key={window.id} className="progress-stat">
                  <div className="progress-head">
                    <span>{label}</span>
                    <span>
                      {state
                        ? `${count(state.usage.requests)} ${tr("req")} · ${count(state.usage.tokens)} ${tr("tokens")}`
                        : "—"}
                    </span>
                  </div>
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress ?? 0}
                  >
                    <div className="progress-fill" style={{ width: `${progress ?? 0}%` }} />
                  </div>
                  <small>
                    {state
                      ? state.blocked
                        ? tr("Limit reached, resets soon.")
                        : tr("Resets {when}.", {
                            when: state.resetsAt
                              ? new Date(state.resetsAt).toLocaleString(activeLocale())
                              : tr("automatically"),
                          })
                      : tr("Starts on your first request.")}
                  </small>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
