import React, { useEffect, useMemo, useRef, useState } from "react";
import ModalPortal from "../ModalPortal";
import { ApiError } from "../../lib/api";
import { copyTextToClipboard } from "../../lib/clipboard";
import { activeLocale, t, useT } from "../../i18n";
import type {
  DashboardCreditEntry,
  DashboardCreditEntryKind,
  DashboardUser,
  DashboardUserPlan,
  DashboardUserQuota,
  DashboardUserQuotaWindow,
  DashboardUserQuotaWindowPeriod,
  DashboardUserRole,
  DashboardUserStatus,
  ExposedModel,
} from "../../types";

type Api = (path: string, init?: RequestInit) => Promise<any>;

type Props = {
  api: Api;
  readOnly?: boolean;
};

type QuotaDraft = {
  period: DashboardUserQuota["period"];
  creditUsd: string;
  maxTokens: string;
  maxRequests: string;
};

type WindowDraft = {
  id: string;
  label: string;
  period: DashboardUserQuotaWindowPeriod;
  creditUsd: string;
  maxTokens: string;
  maxRequests: string;
};

type PlanDraft = {
  mode: "usage" | "subscription";
  name: string;
  priceUsd: string;
  windows: WindowDraft[];
};

const DEFAULT_PLAN: PlanDraft = { mode: "usage", name: "", priceUsd: "", windows: [] };

/** Offered as a one-click starting point when an admin enables a plan. */
const SUBSCRIPTION_PRESET: WindowDraft[] = [
  { id: "5h", label: "5 hours", period: "5h", creditUsd: "", maxTokens: "", maxRequests: "" },
  { id: "week", label: "Weekly", period: "week", creditUsd: "", maxTokens: "", maxRequests: "" },
];

const WINDOW_PERIODS: Array<{ value: DashboardUserQuotaWindowPeriod; label: string }> = [
  { value: "5h", label: "5 hours" },
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
];

const EMPTY_DRAFT = {
  email: "",
  name: "",
  role: "member" as DashboardUserRole,
  password: "",
  allowedModels: [] as string[],
  quota: { period: "month", creditUsd: "", maxTokens: "", maxRequests: "" } as QuotaDraft,
  plan: DEFAULT_PLAN,
};

const DETAIL_TABS = [
  { id: "identity", label: "Identity" },
  { id: "quota", label: "Quota & plan" },
  { id: "models", label: "Models & access" },
  { id: "credits", label: "Credits" },
  { id: "invitation", label: "Invitation" },
] as const;

type DetailTab = (typeof DETAIL_TABS)[number]["id"];

function quotaDraft(quota: DashboardUserQuota): QuotaDraft {
  return {
    period: quota.period,
    creditUsd: quota.creditUsd === undefined ? "" : String(quota.creditUsd),
    maxTokens: quota.maxTokens === undefined ? "" : String(quota.maxTokens),
    maxRequests: quota.maxRequests === undefined ? "" : String(quota.maxRequests),
  };
}

function quotaPayload(draft: QuotaDraft) {
  const value = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  return {
    period: draft.period,
    creditUsd: value(draft.creditUsd),
    maxTokens: value(draft.maxTokens),
    maxRequests: value(draft.maxRequests),
  };
}

function windowDraft(window: DashboardUserQuotaWindow): WindowDraft {
  return {
    id: window.id,
    label: window.label ?? "",
    period: window.period,
    creditUsd: window.creditUsd === undefined ? "" : String(window.creditUsd),
    maxTokens: window.maxTokens === undefined ? "" : String(window.maxTokens),
    maxRequests: window.maxRequests === undefined ? "" : String(window.maxRequests),
  };
}

function planDraft(plan: DashboardUserPlan | undefined): PlanDraft {
  if (!plan || plan.mode !== "subscription") return DEFAULT_PLAN;
  return {
    mode: "subscription",
    name: plan.name ?? "",
    priceUsd: plan.priceUsd === undefined ? "" : String(plan.priceUsd),
    windows: (plan.windows ?? []).map(windowDraft),
  };
}

function planPayload(draft: PlanDraft) {
  if (draft.mode !== "subscription") return { mode: "usage" };
  const value = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  return {
    mode: "subscription",
    name: draft.name.trim() || undefined,
    priceUsd: value(draft.priceUsd),
    windows: draft.windows.map((window) => ({
      id: window.id,
      label: window.label.trim() || undefined,
      period: window.period,
      creditUsd: value(window.creditUsd),
      maxTokens: value(window.maxTokens),
      maxRequests: value(window.maxRequests),
    })),
  };
}

function windowPeriodLabel(period: DashboardUserQuotaWindowPeriod): string {
  if (period === "5h") return t("5 hours");
  if (period === "day") return t("Daily");
  if (period === "week") return t("Weekly");
  return t("Monthly");
}

function money(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

function count(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString(activeLocale()) : "0";
}

function creditKindLabel(tr: (key: string) => string, kind: DashboardCreditEntryKind): string {
  if (kind === "allowance") return tr("Allowance");
  if (kind === "topup") return tr("Top-up");
  if (kind === "refund") return tr("Refund");
  if (kind === "debit") return tr("Debit");
  return tr("Adjustment");
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const map: Record<string, string> = {
      email_in_use: t("That email is already registered."),
      invalid_email: t("Enter a valid email address."),
      weak_password: t("Use at least 8 characters for the password."),
      last_admin: t("At least one active admin must remain."),
      cannot_delete_self: t("You cannot delete your own account."),
      cannot_suspend_self: t("You cannot suspend your own account."),
      not_found: t("That user no longer exists."),
    };
    return map[String((error as any).code ?? error.message)] ?? error.message;
  }
  return error instanceof Error ? error.message : t("The action could not be completed.");
}

/**
 * Accessible viewport dialog built on the shared modal classes. Closes on
 * Escape and on a backdrop click, and keeps the title association for screen
 * readers. The close handler is read through a ref so an inline callback does
 * not re-bind the document listener on every keystroke.
 */
function Dialog({
  labelledBy,
  className,
  onClose,
  children,
}: {
  labelledBy: string;
  className?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <ModalPortal>
      <div
        className="modal-backdrop"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeRef.current();
        }}
      >
        <div
          className={`modal panel${className ? ` ${className}` : ""}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
        >
          {children}
        </div>
      </div>
    </ModalPortal>
  );
}

function ModelAccessPicker({
  catalog,
  value,
  disabled,
  onChange,
}: {
  catalog: ExposedModel[];
  value: string[];
  disabled?: boolean;
  onChange: (models: string[]) => void;
}) {
  const tr = useT();
  const [query, setQuery] = useState("");
  const options = useMemo(() => {
    const ids = new Set<string>(value);
    for (const model of catalog) if (model.id) ids.add(model.id);
    return [...ids].sort((a, b) => a.localeCompare(b));
  }, [catalog, value]);
  const needle = query.trim().toLowerCase();
  const filtered = (needle ? options.filter((id) => id.toLowerCase().includes(needle)) : options).slice(0, 300);
  const toggle = (id: string, checked: boolean) => {
    onChange(checked ? [...new Set([...value, id])] : value.filter((entry) => entry !== id));
  };
  return (
    <div>
      <div className="inline" style={{ gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <input
          type="search"
          value={query}
          disabled={disabled}
          placeholder={tr("Filter models…")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="muted">
          {value.length === 0
            ? tr("All models allowed")
            : tr("{count} models allowed", { count: value.length })}
        </span>
        {value.length > 0 && (
          <button className="btn ghost" type="button" disabled={disabled} onClick={() => onChange([])}>
            {tr("Allow all")}
          </button>
        )}
      </div>
      <div
        style={{
          maxHeight: 240,
          overflowY: "auto",
          border: "1px solid var(--border, rgba(127,127,127,.3))",
          borderRadius: 8,
          padding: 8,
          display: "grid",
          gap: 4,
        }}
      >
        {filtered.length === 0 ? (
          <span className="muted">{tr("No matching models.")}</span>
        ) : (
          filtered.map((id) => (
            <label key={id} className="inline" style={{ gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={value.includes(id)}
                disabled={disabled}
                onChange={(event) => toggle(id, event.target.checked)}
              />
              <code className="mono" style={{ wordBreak: "break-all" }}>{id}</code>
            </label>
          ))
        )}
        {filtered.length === 300 && options.length > 300 && (
          <span className="muted">{tr("Refine the filter to see every model.")}</span>
        )}
      </div>
    </div>
  );
}

export function UsersTab({ api, readOnly = false }: Props) {
  const tr = useT();
  const [users, setUsers] = useState<DashboardUser[]>([]);
  const [catalog, setCatalog] = useState<ExposedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createdInvite, setCreatedInvite] = useState<{ email: string; url: string } | null>(null);
  const [createDraft, setCreateDraft] = useState(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("identity");
  const [editEmail, setEditEmail] = useState("");
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState<DashboardUserRole>("member");
  const [editStatus, setEditStatus] = useState<DashboardUserStatus>("active");
  const [editPassword, setEditPassword] = useState("");
  const [editQuota, setEditQuota] = useState<QuotaDraft>({ period: "month", creditUsd: "", maxTokens: "", maxRequests: "" });
  const [editPlan, setEditPlan] = useState<PlanDraft>(DEFAULT_PLAN);
  const [editAllowedModels, setEditAllowedModels] = useState<string[]>([]);
  const [creditAmount, setCreditAmount] = useState("");
  const [walletAmount, setWalletAmount] = useState("");
  const [walletNote, setWalletNote] = useState("");
  const [ledger, setLedger] = useState<DashboardCreditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState("");
  const [copied, setCopied] = useState(false);
  const addUserButtonRef = useRef<HTMLButtonElement | null>(null);
  const createEmailRef = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(
    () => users.find((user) => user.id === selectedId) ?? null,
    [users, selectedId],
  );

  const refresh = async () => {
    setLoading(true);
    try {
      const result = await api("users");
      setUsers(Array.isArray(result?.users) ? result.users : []);
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    void api("/v1/models")
      .then((result) => setCatalog(Array.isArray(result?.data) ? result.data : []))
      .catch(() => setCatalog([]));
  }, []);

  useEffect(() => {
    if (!createOpen) return;
    createEmailRef.current?.focus();
  }, [createOpen]);

  useEffect(() => {
    if (!selectedId) {
      setLedger([]);
      return;
    }
    let active = true;
    void api(`users/${selectedId}/credits`)
      .then((result) => {
        if (active) setLedger(Array.isArray(result?.ledger) ? result.ledger : []);
      })
      .catch(() => {
        if (active) setLedger([]);
      });
    return () => {
      active = false;
    };
  }, [selectedId, users]);

  useEffect(() => {
    if (!selected) return;
    setEditEmail(selected.email);
    setEditName(selected.name ?? "");
    setEditRole(selected.role);
    setEditStatus(selected.status);
    setEditPassword("");
    setEditQuota(quotaDraft(selected.quota));
    setEditPlan(planDraft(selected.plan));
    setEditAllowedModels(selected.allowedModels ?? []);
    setCreditAmount("");
    setWalletAmount("");
    setWalletNote("");
  }, [selectedId, users]);

  // A generated invite link must survive the `users` refresh that follows it,
  // so it is cleared only when the admin selects another user.
  useEffect(() => {
    setInviteLink("");
    setCopied(false);
  }, [selectedId]);

  const run = async (action: () => Promise<void>) => {
    if (readOnly) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const inviteUrl = (path: string | undefined) =>
    path ? `${window.location.origin}${path}` : "";

  const closeCreate = () => {
    if (creating) return;
    setCreateOpen(false);
    setCreateDraft(EMPTY_DRAFT);
    addUserButtonRef.current?.focus();
  };

  const closeCreatedInvite = () => {
    setCreatedInvite(null);
    setCopied(false);
    window.requestAnimationFrame(() => addUserButtonRef.current?.focus());
  };

  const create = (event: React.FormEvent) => {
    event.preventDefault();
    const email = createDraft.email;
    void run(async () => {
      setCreating(true);
      const result = await api("users", {
        method: "POST",
        body: JSON.stringify({
          email: createDraft.email,
          name: createDraft.name || undefined,
          role: createDraft.role,
          password: createDraft.password || undefined,
          quota: quotaPayload(createDraft.quota),
          plan: planPayload(createDraft.plan),
          allowedModels: createDraft.allowedModels,
        }),
      });
      setCreateDraft(EMPTY_DRAFT);
      setCreateOpen(false);
      setNotice(tr("User created."));
      if (result?.invitePath) {
        setCreatedInvite({ email, url: inviteUrl(result.invitePath) });
      } else {
        window.requestAnimationFrame(() => addUserButtonRef.current?.focus());
      }
      await refresh();
    }).finally(() => setCreating(false));
  };

  const save = () => {
    if (!selected) return;
    void run(async () => {
      await api(`users/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          email: editEmail,
          name: editName,
          role: editRole,
          status: editStatus,
          quota: quotaPayload(editQuota),
          plan: planPayload(editPlan),
          allowedModels: editAllowedModels,
          ...(editPassword ? { password: editPassword } : {}),
        }),
      });
      setEditPassword("");
      setNotice(tr("User updated."));
      await refresh();
    });
  };

  const credit = () => {
    if (!selected) return;
    void run(async () => {
      await api(`users/${selected.id}/credit`, {
        method: "POST",
        body: JSON.stringify({ amountUsd: Number(creditAmount) }),
      });
      setCreditAmount("");
      setNotice(tr("Allowance added."));
      await refresh();
    });
  };

  const adjustWallet = (direction: 1 | -1) => {
    if (!selected) return;
    const amount = Math.abs(Number(walletAmount));
    if (!Number.isFinite(amount) || amount <= 0) return;
    const note = walletNote.trim();
    void run(async () => {
      await api(`users/${selected.id}/wallet`, {
        method: "POST",
        body: JSON.stringify({
          amountUsd: direction * amount,
          ...(note ? { note } : {}),
        }),
      });
      setWalletAmount("");
      setWalletNote("");
      setNotice(direction > 0 ? tr("Prepaid balance topped up.") : tr("Prepaid balance debited."));
      await refresh();
    });
  };

  const resetUsage = () => {
    if (!selected) return;
    void run(async () => {
      await api(`users/${selected.id}/reset-usage`, { method: "POST" });
      setNotice(tr("Usage counters reset."));
      await refresh();
    });
  };

  const setPlanMode = (mode: "usage" | "subscription") => {
    setEditPlan((current) => ({
      ...current,
      mode,
      windows:
        mode === "subscription" && current.windows.length === 0
          ? SUBSCRIPTION_PRESET.map((window) => ({ ...window }))
          : current.windows,
    }));
  };

  const updateWindow = (id: string, patch: Partial<WindowDraft>) => {
    setEditPlan((current) => ({
      ...current,
      windows: current.windows.map((window) => (window.id === id ? { ...window, ...patch } : window)),
    }));
  };

  const addWindow = () => {
    setEditPlan((current) => ({
      ...current,
      windows: [
        ...current.windows,
        {
          id: `w${Date.now().toString(36)}`,
          label: "",
          period: "week",
          creditUsd: "",
          maxTokens: "",
          maxRequests: "",
        },
      ],
    }));
  };

  const removeWindow = (id: string) => {
    setEditPlan((current) => ({
      ...current,
      windows: current.windows.filter((window) => window.id !== id),
    }));
  };

  const removePasskey = (passkeyId: string) => {
    if (!selected) return;
    void run(async () => {
      await api(`users/${selected.id}/passkeys/${encodeURIComponent(passkeyId)}`, {
        method: "DELETE",
      });
      setNotice(tr("Passkey removed."));
      await refresh();
    });
  };

  const invite = () => {
    if (!selected) return;
    void run(async () => {
      const result = await api(`users/${selected.id}/invite`, { method: "POST" });
      setInviteLink(inviteUrl(result?.invitePath));
      setNotice(tr("Invite link generated. It expires in 7 days."));
      await refresh();
    });
  };

  const remove = () => {
    if (!selected) return;
    if (!window.confirm(tr("Delete {email} and all of their keys and providers?", { email: selected.email }))) return;
    void run(async () => {
      await api(`users/${selected.id}`, { method: "DELETE" });
      setSelectedId(null);
      setNotice(tr("User deleted."));
      await refresh();
    });
  };

  const copyInvite = async (value: string) => {
    if (!value) return;
    await copyTextToClipboard(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const openInvitation = (id: string) => {
    setSelectedId(id);
    setDetailTab("invitation");
  };

  const toggleSelected = (id: string) => {
    if (selectedId === id) {
      setSelectedId(null);
      return;
    }
    setSelectedId(id);
    setDetailTab("identity");
  };

  const statusMessages = (
    <>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
    </>
  );

  return (
    <div className="tab-stack">
      <section className="panel">
        <div className="section-split-header">
          <div>
            <h2>{tr("Users")}</h2>
            <p className="muted">
              {tr("Each user signs in with their own account and only sees their own providers, keys, activity and quota.")}
            </p>
          </div>
          <button
            ref={addUserButtonRef}
            className="btn"
            type="button"
            disabled={readOnly}
            aria-haspopup="dialog"
            aria-expanded={createOpen}
            onClick={() => setCreateOpen(true)}
          >
            {tr("Add user")}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {notice && <div className="notice">{notice}</div>}
        {loading ? (
          <p className="muted">{tr("Loading users…")}</p>
        ) : users.length === 0 ? (
          <div className="compact-empty-state">
            <strong>{tr("No users yet")}</strong>
            <span>{tr("Create the first account with the Add user button. The admin token still works as a fallback.")}</span>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{tr("User")}</th>
                  <th>{tr("Role")}</th>
                  <th>{tr("Status")}</th>
                  <th>{tr("Usage")}</th>
                  <th>{tr("Quota")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className={selectedId === user.id ? "is-selected" : undefined}>
                    <td>
                      <strong>{user.name || user.email}</strong>
                      {user.name && <div className="muted">{user.email}</div>}
                      {user.invitePending && <span className="badge">{tr("Invite pending")}</span>}
                    </td>
                    <td>{tr(user.role === "admin" ? "Admin" : "Member")}</td>
                    <td>{tr(user.status === "active" ? "Active" : "Suspended")}</td>
                    <td>
                      <div>{count(user.usage.requests)} {tr("req")}</div>
                      <div className="muted">{count(user.usage.tokens)} {tr("tokens")} · {money(user.usage.costUsd)}</div>
                    </td>
                    <td>
                      {user.plan?.mode === "subscription" ? (
                        <>
                          <div>{user.plan.name || tr("Subscription")}</div>
                          <div className="muted">
                            {(user.quotaWindows ?? [])
                              .map((window) =>
                                `${window.label || windowPeriodLabel(window.period)}: ${count(window.usage.requests)} ${tr("req")}`,
                              )
                              .join(" · ") || tr("No windows")}
                          </div>
                        </>
                      ) : (
                        <>
                          <div>{tr(user.quota.period === "day" ? "Daily" : user.quota.period === "month" ? "Monthly" : "Total")}</div>
                          <div className="muted">
                            {user.quota.creditUsd === undefined ? tr("No credit cap") : money(user.quota.creditUsd)} ·{" "}
                            {user.quota.maxTokens === undefined ? `∞ ${tr("tokens")}` : count(user.quota.maxTokens)} ·{" "}
                            {user.quota.maxRequests === undefined ? `∞ ${tr("req")}` : count(user.quota.maxRequests)}
                          </div>
                        </>
                      )}
                      {typeof user.walletUsd === "number" && (
                        <div className="muted">
                          {tr("{amount} prepaid", { amount: money(user.walletUsd) })}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="inline" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        <button
                          className="btn ghost"
                          type="button"
                          aria-label={tr("Manage invitation for {email}", { email: user.email })}
                          onClick={() => openInvitation(user.id)}
                        >
                          {tr("Invite")}
                        </button>
                        <button
                          className="btn secondary"
                          type="button"
                          onClick={() => toggleSelected(user.id)}
                        >
                          {selectedId === user.id ? tr("Close") : tr("Manage")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && (
        <section className="panel" role="region" aria-label={tr("Manage {email}", { email: selected.email })}>
          <div className="section-split-header">
            <div>
              <h2>{selected.name || selected.email}</h2>
              <p className="muted">
                {selected.hasPassword ? tr("Password sign-in enabled") : tr("Invite pending")} ·{" "}
                {selected.usage.remainingCreditUsd === undefined
                  ? tr("Unlimited credit")
                  : tr("{amount} credit remaining", { amount: money(selected.usage.remainingCreditUsd) })}
                {typeof selected.walletUsd === "number"
                  ? ` · ${tr("{amount} prepaid", { amount: money(selected.walletUsd) })}`
                  : ""}
              </p>
            </div>
            <div className="inline wrap" style={{ justifyContent: "flex-end" }}>
              <button className="btn" type="button" disabled={readOnly || busy} onClick={save}>
                {busy ? tr("Saving…") : tr("Save changes")}
              </button>
              <button className="btn secondary" type="button" disabled={readOnly || busy} onClick={resetUsage}>
                {tr("Reset usage")}
              </button>
              <button className="btn danger" type="button" disabled={readOnly || busy} onClick={remove}>
                {tr("Delete user")}
              </button>
            </div>
          </div>
          {statusMessages}

          <div className="alias-tabs user-detail-tabs" role="tablist" aria-label={tr("User sections")}>
            {DETAIL_TABS.map((tab) => (
              <button
                key={tab.id}
                className={`alias-tab${detailTab === tab.id ? " active" : ""}`}
                type="button"
                role="tab"
                id={`user-tab-${tab.id}`}
                aria-selected={detailTab === tab.id}
                aria-controls={`user-panel-${tab.id}`}
                onClick={() => setDetailTab(tab.id)}
              >
                <span className="alias-tab-label">{tr(tab.label)}</span>
              </button>
            ))}
          </div>

          {detailTab === "identity" && (
            <div
              className="tab-stack"
              role="tabpanel"
              id="user-panel-identity"
              aria-labelledby="user-tab-identity"
              style={{ marginTop: 15 }}
            >
              <div className="form-grid">
                <label className="control-field">
                  <span className="control-label">{tr("Email")}</span>
                  <input
                    type="email"
                    value={editEmail}
                    disabled={readOnly || busy}
                    onChange={(event) => setEditEmail(event.target.value)}
                  />
                </label>
                <label className="control-field">
                  <span className="control-label">{tr("Name")}</span>
                  <input
                    value={editName}
                    disabled={readOnly || busy}
                    onChange={(event) => setEditName(event.target.value)}
                  />
                </label>
                <label className="control-field">
                  <span className="control-label">{tr("Role")}</span>
                  <select
                    value={editRole}
                    disabled={readOnly || busy}
                    onChange={(event) => setEditRole(event.target.value as DashboardUserRole)}
                  >
                    <option value="member">{tr("Member")}</option>
                    <option value="admin">{tr("Admin")}</option>
                  </select>
                </label>
                <label className="control-field">
                  <span className="control-label">{tr("Status")}</span>
                  <select
                    value={editStatus}
                    disabled={readOnly || busy}
                    onChange={(event) => setEditStatus(event.target.value as DashboardUserStatus)}
                  >
                    <option value="active">{tr("Active")}</option>
                    <option value="suspended">{tr("Suspended")}</option>
                  </select>
                </label>
                <label className="control-field">
                  <span className="control-label">{tr("New password")}</span>
                  <input
                    type="password"
                    value={editPassword}
                    disabled={readOnly || busy}
                    placeholder={tr("Leave blank to keep current")}
                    autoComplete="new-password"
                    onChange={(event) => setEditPassword(event.target.value)}
                  />
                </label>
              </div>
              <div>
                <h3>{tr("Passkeys")}</h3>
                <p className="muted">{tr("Registered on the user's own devices. Remove one if it is lost.")}</p>
                {selected.passkeys.length === 0 ? (
                  <p className="muted">{tr("No passkeys registered.")}</p>
                ) : (
                  <div className="inline" style={{ gap: 8, flexWrap: "wrap" }}>
                    {selected.passkeys.map((passkey) => (
                      <span
                        key={passkey.id}
                        className="badge"
                        style={{ display: "inline-flex", gap: 6, alignItems: "center" }}
                      >
                        {passkey.name || tr("Passkey")}
                        <button
                          className="btn ghost"
                          type="button"
                          disabled={readOnly || busy}
                          onClick={() => removePasskey(passkey.id)}
                        >
                          {tr("Remove")}
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {detailTab === "quota" && (
            <div
              className="tab-stack"
              role="tabpanel"
              id="user-panel-quota"
              aria-labelledby="user-tab-quota"
              style={{ marginTop: 15 }}
            >
              <div>
                <h3>{tr("Usage quota")}</h3>
                <p className="muted">{tr("Caps apply per period. Leave a cap blank for unlimited.")}</p>
                <div className="form-grid">
                  <label className="control-field">
                    <span className="control-label">{tr("Quota period")}</span>
                    <select
                      value={editQuota.period}
                      disabled={readOnly || busy}
                      onChange={(event) =>
                        setEditQuota((current) => ({ ...current, period: event.target.value as QuotaDraft["period"] }))
                      }
                    >
                      <option value="day">{tr("Daily")}</option>
                      <option value="month">{tr("Monthly")}</option>
                      <option value="total">{tr("Total")}</option>
                    </select>
                  </label>
                  <label className="control-field">
                    <span className="control-label">{tr("Credit cap (USD)")}</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={editQuota.creditUsd}
                      disabled={readOnly || busy}
                      placeholder={tr("Unlimited")}
                      onChange={(event) => setEditQuota((current) => ({ ...current, creditUsd: event.target.value }))}
                    />
                  </label>
                  <label className="control-field">
                    <span className="control-label">{tr("Token cap")}</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={editQuota.maxTokens}
                      disabled={readOnly || busy}
                      placeholder={tr("Unlimited")}
                      onChange={(event) => setEditQuota((current) => ({ ...current, maxTokens: event.target.value }))}
                    />
                  </label>
                  <label className="control-field">
                    <span className="control-label">{tr("Request cap")}</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={editQuota.maxRequests}
                      disabled={readOnly || busy}
                      placeholder={tr("Unlimited")}
                      onChange={(event) => setEditQuota((current) => ({ ...current, maxRequests: event.target.value }))}
                    />
                  </label>
                </div>
              </div>
              <div>
                <h3>{tr("Billing")}</h3>
                <p className="muted">
                  {tr("Subscription windows are enforced on top of the usage quota. Leave a cap blank for unlimited.")}
                </p>
                <div className="form-grid">
                  <label className="control-field">
                    <span className="control-label">{tr("Billing mode")}</span>
                    <select
                      value={editPlan.mode}
                      disabled={readOnly || busy}
                      onChange={(event) => setPlanMode(event.target.value as PlanDraft["mode"])}
                    >
                      <option value="usage">{tr("Pay-as-you-go")}</option>
                      <option value="subscription">{tr("Subscription")}</option>
                    </select>
                  </label>
                  {editPlan.mode === "subscription" && (
                    <>
                      <label className="control-field">
                        <span className="control-label">{tr("Plan name")}</span>
                        <input
                          value={editPlan.name}
                          disabled={readOnly || busy}
                          placeholder={tr("Pro")}
                          onChange={(event) => setEditPlan((current) => ({ ...current, name: event.target.value }))}
                        />
                      </label>
                      <label className="control-field">
                        <span className="control-label">{tr("Monthly price (USD)")}</span>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={editPlan.priceUsd}
                          disabled={readOnly || busy}
                          placeholder="20"
                          onChange={(event) => setEditPlan((current) => ({ ...current, priceUsd: event.target.value }))}
                        />
                      </label>
                    </>
                  )}
                </div>
                {editPlan.mode === "subscription" && (
                  <>
                    {editPlan.windows.length === 0 ? (
                      <div className="compact-empty-state" style={{ marginTop: 12 }}>
                        <strong>{tr("No windows yet")}</strong>
                        <span>{tr("Add a window or start from the 5 h + weekly preset.")}</span>
                      </div>
                    ) : (
                      <div className="table-wrap" style={{ marginTop: 12 }}>
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>{tr("Window")}</th>
                              <th>{tr("Period")}</th>
                              <th>{tr("Credit cap (USD)")}</th>
                              <th>{tr("Token cap")}</th>
                              <th>{tr("Request cap")}</th>
                              <th>{tr("Current usage")}</th>
                              <th />
                            </tr>
                          </thead>
                          <tbody>
                            {editPlan.windows.map((window) => {
                              const live = selected.quotaWindows?.find((entry) => entry.id === window.id);
                              return (
                                <tr key={window.id}>
                                  <td>
                                    <input
                                      value={window.label}
                                      disabled={readOnly || busy}
                                      placeholder={windowPeriodLabel(window.period)}
                                      onChange={(event) => updateWindow(window.id, { label: event.target.value })}
                                    />
                                  </td>
                                  <td>
                                    <select
                                      value={window.period}
                                      disabled={readOnly || busy}
                                      onChange={(event) =>
                                        updateWindow(window.id, {
                                          period: event.target.value as DashboardUserQuotaWindowPeriod,
                                        })
                                      }
                                    >
                                      {WINDOW_PERIODS.map((entry) => (
                                        <option key={entry.value} value={entry.value}>
                                          {windowPeriodLabel(entry.value)}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td>
                                    <input
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      value={window.creditUsd}
                                      disabled={readOnly || busy}
                                      placeholder={tr("Unlimited")}
                                      onChange={(event) => updateWindow(window.id, { creditUsd: event.target.value })}
                                    />
                                  </td>
                                  <td>
                                    <input
                                      type="number"
                                      min="0"
                                      step="1"
                                      value={window.maxTokens}
                                      disabled={readOnly || busy}
                                      placeholder={tr("Unlimited")}
                                      onChange={(event) => updateWindow(window.id, { maxTokens: event.target.value })}
                                    />
                                  </td>
                                  <td>
                                    <input
                                      type="number"
                                      min="0"
                                      step="1"
                                      value={window.maxRequests}
                                      disabled={readOnly || busy}
                                      placeholder={tr("Unlimited")}
                                      onChange={(event) => updateWindow(window.id, { maxRequests: event.target.value })}
                                    />
                                  </td>
                                  <td className="muted">
                                    {live ? (
                                      <>
                                        {count(live.usage.requests)} {tr("req")} · {count(live.usage.tokens)}{" "}
                                        {tr("tokens")} · {money(live.usage.costUsd)}
                                        {live.blocked && <div><span className="badge">{tr("Limit reached")}</span></div>}
                                      </>
                                    ) : (
                                      tr("Not started")
                                    )}
                                  </td>
                                  <td>
                                    <button
                                      className="btn ghost"
                                      type="button"
                                      disabled={readOnly || busy}
                                      onClick={() => removeWindow(window.id)}
                                    >
                                      {tr("Remove")}
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div className="inline" style={{ gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                      <button className="btn secondary" type="button" disabled={readOnly || busy} onClick={addWindow}>
                        {tr("Add window")}
                      </button>
                      <button
                        className="btn secondary"
                        type="button"
                        disabled={readOnly || busy}
                        onClick={() =>
                          setEditPlan((current) => ({
                            ...current,
                            windows: SUBSCRIPTION_PRESET.map((window) => ({ ...window })),
                          }))
                        }
                      >
                        {tr("Use 5 h + weekly preset")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {detailTab === "models" && (
            <div
              className="tab-stack"
              role="tabpanel"
              id="user-panel-models"
              aria-labelledby="user-tab-models"
              style={{ marginTop: 15 }}
            >
              <div>
                <h3>{tr("Model access")}</h3>
                <p className="muted">
                  {tr("Choose the models this user may call. Leave all unchecked to allow every model.")}
                </p>
                <ModelAccessPicker
                  catalog={catalog}
                  value={editAllowedModels}
                  disabled={readOnly || busy}
                  onChange={setEditAllowedModels}
                />
              </div>
            </div>
          )}

          {detailTab === "credits" && (
            <div
              className="tab-stack"
              role="tabpanel"
              id="user-panel-credits"
              aria-labelledby="user-tab-credits"
              style={{ marginTop: 15 }}
            >
              <div>
                <h3>{tr("Allowance")}</h3>
                <p className="muted">{tr("One-off credit added on top of the current period allowance.")}</p>
                <div className="inline wrap">
                  <label className="control-field" style={{ maxWidth: 220 }}>
                    <span className="control-label">{tr("Add allowance (USD)")}</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={creditAmount}
                      disabled={readOnly || busy}
                      placeholder="10"
                      onChange={(event) => setCreditAmount(event.target.value)}
                    />
                  </label>
                  <button
                    className="btn"
                    type="button"
                    disabled={readOnly || busy || !(Number(creditAmount) > 0)}
                    onClick={credit}
                  >
                    {tr("Grant allowance")}
                  </button>
                </div>
              </div>
              <div>
                <div className="section-split-header">
                  <div>
                    <h3>{tr("Prepaid balance")}</h3>
                    <p className="muted">
                      {tr("Purchased credit that never expires with the period. It is spent after the period allowance.")}
                    </p>
                  </div>
                  <strong>{money(selected.walletUsd ?? 0)}</strong>
                </div>
                <div className="inline wrap">
                  <label className="control-field" style={{ maxWidth: 180 }}>
                    <span className="control-label">{tr("Amount (USD)")}</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={walletAmount}
                      disabled={readOnly || busy}
                      placeholder="20"
                      onChange={(event) => setWalletAmount(event.target.value)}
                    />
                  </label>
                  <label className="control-field" style={{ minWidth: 200, flex: 1 }}>
                    <span className="control-label">{tr("Note (optional)")}</span>
                    <input
                      value={walletNote}
                      disabled={readOnly || busy}
                      maxLength={200}
                      placeholder={tr("Pack Starter, goodwill, refund…")}
                      onChange={(event) => setWalletNote(event.target.value)}
                    />
                  </label>
                  <button
                    className="btn"
                    type="button"
                    disabled={readOnly || busy || !(Math.abs(Number(walletAmount)) > 0)}
                    onClick={() => adjustWallet(1)}
                  >
                    {tr("Top up")}
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={readOnly || busy || !(Math.abs(Number(walletAmount)) > 0)}
                    onClick={() => adjustWallet(-1)}
                  >
                    {tr("Debit")}
                  </button>
                </div>
                {ledger.length > 0 ? (
                  <div className="table-wrap" style={{ marginTop: 12 }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>{tr("When")}</th>
                          <th>{tr("Movement")}</th>
                          <th>{tr("Amount")}</th>
                          <th>{tr("Balance")}</th>
                          <th>{tr("Note")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ledger.slice(0, 8).map((entry) => (
                          <tr key={entry.id}>
                            <td>{new Date(entry.at).toLocaleString(activeLocale())}</td>
                            <td>{creditKindLabel(tr, entry.kind)}</td>
                            <td>
                              {entry.amountUsd > 0 ? "+" : ""}
                              {money(entry.amountUsd)}
                            </td>
                            <td>{money(entry.balanceAfterUsd)}</td>
                            <td className="muted">{entry.note || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="muted" style={{ marginTop: 12 }}>{tr("No credit movements yet.")}</p>
                )}
              </div>
            </div>
          )}

          {detailTab === "invitation" && (
            <div
              className="tab-stack"
              role="tabpanel"
              id="user-panel-invitation"
              aria-labelledby="user-tab-invitation"
              style={{ marginTop: 15 }}
            >
              <div>
                <div className="section-split-header">
                  <div>
                    <h3>{tr("Invitation link")}</h3>
                    <p className="muted">
                      {tr("The invitation link is single-use and is only displayed when it is generated. Generating a new link invalidates the previous one.")}
                    </p>
                  </div>
                  {selected.invitePending ? (
                    <span className="badge">{tr("Invite pending")}</span>
                  ) : (
                    <span className="badge">{tr("No pending invite")}</span>
                  )}
                </div>
                {selected.invitePending && typeof selected.inviteExpiresAt === "number" && (
                  <p className="muted">
                    {tr("Expires {date}.", {
                      date: new Date(selected.inviteExpiresAt).toLocaleString(activeLocale()),
                    })}
                  </p>
                )}
                <div className="inline wrap">
                  <button className="btn" type="button" disabled={readOnly || busy} onClick={invite}>
                    {selected.invitePending ? tr("Regenerate invite link") : tr("Generate invite link")}
                  </button>
                </div>
                {inviteLink ? (
                  <div className="user-invite-link">
                    <input
                      readOnly
                      value={inviteLink}
                      aria-label={tr("Invitation link")}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <button className="btn secondary" type="button" onClick={() => void copyInvite(inviteLink)}>
                      {copied ? tr("Copied") : tr("Copy")}
                    </button>
                  </div>
                ) : (
                  <p className="muted" style={{ marginTop: 10 }}>
                    {tr("No link generated in this session. Generate one to display it here.")}
                  </p>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {createOpen && (
        <Dialog labelledBy="create-user-title" className="user-create-modal" onClose={closeCreate}>
          <div className="section-split-header">
            <div>
              <h2 id="create-user-title">{tr("Create user")}</h2>
              <p className="muted">
                {tr("Set a password to create the account immediately, or leave it blank to send an invite.")}
              </p>
            </div>
            <button
              className="btn ghost"
              type="button"
              disabled={creating}
              aria-label={tr("Close")}
              onClick={closeCreate}
            >
              ×
            </button>
          </div>
          {error && <div className="error" role="alert">{error}</div>}
          <form onSubmit={create}>
            <div className="form-grid">
              <label className="control-field">
                <span className="control-label">{tr("Email")}</span>
                <input
                  ref={createEmailRef}
                  type="email"
                  required
                  value={createDraft.email}
                  disabled={readOnly || creating}
                  onChange={(event) => setCreateDraft((current) => ({ ...current, email: event.target.value }))}
                />
              </label>
              <label className="control-field">
                <span className="control-label">{tr("Name")}</span>
                <input
                  value={createDraft.name}
                  disabled={readOnly || creating}
                  onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))}
                />
              </label>
              <label className="control-field">
                <span className="control-label">{tr("Role")}</span>
                <select
                  value={createDraft.role}
                  disabled={readOnly || creating}
                  onChange={(event) =>
                    setCreateDraft((current) => ({ ...current, role: event.target.value as DashboardUserRole }))
                  }
                >
                  <option value="member">{tr("Member")}</option>
                  <option value="admin">{tr("Admin")}</option>
                </select>
              </label>
              <label className="control-field">
                <span className="control-label">{tr("Password")}</span>
                <input
                  type="password"
                  value={createDraft.password}
                  disabled={readOnly || creating}
                  placeholder={tr("Optional — invite instead")}
                  autoComplete="new-password"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, password: event.target.value }))}
                />
              </label>
              <label className="control-field">
                <span className="control-label">{tr("Quota period")}</span>
                <select
                  value={createDraft.quota.period}
                  disabled={readOnly || creating}
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      quota: { ...current.quota, period: event.target.value as QuotaDraft["period"] },
                    }))
                  }
                >
                  <option value="month">{tr("Monthly")}</option>
                  <option value="day">{tr("Daily")}</option>
                  <option value="total">{tr("Total")}</option>
                </select>
              </label>
              <label className="control-field">
                <span className="control-label">{tr("Credit cap (USD)")}</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={createDraft.quota.creditUsd}
                  disabled={readOnly || creating}
                  placeholder={tr("Unlimited")}
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      quota: { ...current.quota, creditUsd: event.target.value },
                    }))
                  }
                />
              </label>
              <label className="control-field">
                <span className="control-label">{tr("Token cap")}</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={createDraft.quota.maxTokens}
                  disabled={readOnly || creating}
                  placeholder={tr("Unlimited")}
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      quota: { ...current.quota, maxTokens: event.target.value },
                    }))
                  }
                />
              </label>
              <label className="control-field">
                <span className="control-label">{tr("Request cap")}</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={createDraft.quota.maxRequests}
                  disabled={readOnly || creating}
                  placeholder={tr("Unlimited")}
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      quota: { ...current.quota, maxRequests: event.target.value },
                    }))
                  }
                />
              </label>
              <label className="control-field">
                <span className="control-label">{tr("Billing mode")}</span>
                <select
                  value={createDraft.plan.mode}
                  disabled={readOnly || creating}
                  onChange={(event) =>
                    setCreateDraft((current) => {
                      const mode = event.target.value as PlanDraft["mode"];
                      return {
                        ...current,
                        plan: {
                          ...current.plan,
                          mode,
                          windows:
                            mode === "subscription" && current.plan.windows.length === 0
                              ? SUBSCRIPTION_PRESET.map((window) => ({ ...window }))
                              : current.plan.windows,
                        },
                      };
                    })
                  }
                >
                  <option value="usage">{tr("Pay-as-you-go")}</option>
                  <option value="subscription">{tr("Subscription")}</option>
                </select>
              </label>
              {createDraft.plan.mode === "subscription" && (
                <label className="control-field">
                  <span className="control-label">{tr("Plan name")}</span>
                  <input
                    value={createDraft.plan.name}
                    disabled={readOnly || creating}
                    placeholder={tr("Pro")}
                    onChange={(event) =>
                      setCreateDraft((current) => ({
                        ...current,
                        plan: { ...current.plan, name: event.target.value },
                      }))
                    }
                  />
                </label>
              )}
            </div>
            <div style={{ marginTop: 18 }}>
              <h3>{tr("Model access")}</h3>
              <p className="muted">
                {tr("Choose the models this user may call. Leave all unchecked to allow every model.")}
              </p>
              <ModelAccessPicker
                catalog={catalog}
                value={createDraft.allowedModels}
                disabled={readOnly || creating}
                onChange={(models) => setCreateDraft((current) => ({ ...current, allowedModels: models }))}
              />
            </div>
            <div className="inline wrap" style={{ marginTop: 16 }}>
              <button className="btn" type="submit" disabled={readOnly || creating || !createDraft.email.trim()}>
                {creating ? tr("Creating…") : tr("Create user")}
              </button>
              <button className="btn secondary" type="button" disabled={creating} onClick={closeCreate}>
                {tr("Cancel")}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {createdInvite && (
        <Dialog labelledBy="created-invite-title" className="user-invite-modal" onClose={closeCreatedInvite}>
          <div>
            <span className="badge badge-live">{tr("User created")}</span>
            <h2 id="created-invite-title">{tr("Send the invitation link")}</h2>
            <p className="muted">
              {tr("This link is single-use: it stops working once {email} sets a password.", {
                email: createdInvite.email,
              })}
            </p>
          </div>
          <div className="user-invite-link">
            <input
              readOnly
              value={createdInvite.url}
              aria-label={tr("Invitation link")}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              className="btn secondary"
              type="button"
              autoFocus
              onClick={() => void copyInvite(createdInvite.url)}
            >
              {copied ? tr("Copied") : tr("Copy")}
            </button>
          </div>
          <div className="inline wrap">
            <button className="btn" type="button" onClick={closeCreatedInvite}>
              {tr("Done")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
