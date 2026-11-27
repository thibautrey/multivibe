import React, { useEffect, useMemo, useState } from "react";
import { useDashboardApi } from "../adapter";
import { useT } from "../i18n";
import type {
  DashboardModelBillingRate,
  DashboardOffPeakDay,
  DashboardOffPeakSchedule,
  ExposedModel,
} from "../types";

type FormDraft = {
  model: string;
  inputPer1M: string;
  outputPer1M: string;
  cachedInputPer1M: string;
  offPeakInputPer1M: string;
  offPeakOutputPer1M: string;
  offPeakCachedInputPer1M: string;
};

const EMPTY_FORM: FormDraft = {
  model: "",
  inputPer1M: "",
  outputPer1M: "",
  cachedInputPer1M: "",
  offPeakInputPer1M: "",
  offPeakOutputPer1M: "",
  offPeakCachedInputPer1M: "",
};

const DAYS: readonly DashboardOffPeakDay[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const DAY_LABEL: Record<DashboardOffPeakDay, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

type ScheduleDraft = {
  enabled: boolean;
  timezone: string;
  days: Record<DashboardOffPeakDay, Array<{ start: string; end: string }>>;
};

function emptyDays(): ScheduleDraft["days"] {
  return {
    mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
  };
}

function scheduleDraft(schedule: DashboardOffPeakSchedule | null | undefined): ScheduleDraft {
  const days = emptyDays();
  for (const day of DAYS) {
    days[day] = (schedule?.days?.[day] ?? []).map((window) => ({
      start: window.start,
      end: window.end,
    }));
  }
  return {
    enabled: schedule?.enabled === true,
    timezone: schedule?.timezone || "UTC",
    days,
  };
}

function numberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : undefined;
}

function timezones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf?.("timeZone");
  if (Array.isArray(supported) && supported.length) return supported;
  return [
    "UTC", "Europe/Paris", "Europe/London", "America/New_York",
    "America/Los_Angeles", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney",
  ];
}

/**
 * Billed rates for models, in USD per million tokens. Upstream provider prices
 * remain the fallback; setting a model here changes what users are charged and
 * what quota accounting counts. An optional weekly calendar replaces those
 * rates with the model's off-peak rates inside the configured windows.
 */
export function ModelBillingPanel() {
  const t = useT();
  const api = useDashboardApi();
  const [billing, setBilling] = useState<Record<string, DashboardModelBillingRate>>({});
  const [models, setModels] = useState<string[]>([]);
  const [form, setForm] = useState<FormDraft>(EMPTY_FORM);
  const [schedule, setSchedule] = useState<ScheduleDraft>(scheduleDraft(null));
  const [busy, setBusy] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [error, setError] = useState("");
  const [scheduleError, setScheduleError] = useState("");
  const [notice, setNotice] = useState("");
  const [scheduleNotice, setScheduleNotice] = useState("");

  useEffect(() => {
    void api("model-billing")
      .then((result) => {
        setBilling((result?.billing ?? {}) as Record<string, DashboardModelBillingRate>);
        setSchedule(scheduleDraft((result?.schedule ?? null) as DashboardOffPeakSchedule | null));
      })
      .catch(() => setBilling({}));
    void api("/v1/models")
      .then((result) => {
        const entries = Array.isArray(result?.data) ? (result.data as ExposedModel[]) : [];
        setModels(entries.map((entry) => entry.id).filter(Boolean).sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => setModels([]));
  }, []);

  const configured = useMemo(
    () => Object.entries(billing).sort(([a], [b]) => a.localeCompare(b)),
    [billing],
  );
  const zones = useMemo(timezones, []);

  const save = async () => {
    const model = form.model.trim();
    const inputPer1M = Number(form.inputPer1M);
    const outputPer1M = Number(form.outputPer1M);
    const cachedInputPer1M = numberOrUndefined(form.cachedInputPer1M);
    const offPeakInput = numberOrUndefined(form.offPeakInputPer1M);
    const offPeakOutput = numberOrUndefined(form.offPeakOutputPer1M);
    const offPeakCached = numberOrUndefined(form.offPeakCachedInputPer1M);
    const price = (value: number | undefined) => value === undefined || (Number.isFinite(value) && value >= 0);
    if (
      !model ||
      !Number.isFinite(inputPer1M) ||
      !Number.isFinite(outputPer1M) ||
      inputPer1M < 0 ||
      outputPer1M < 0 ||
      !price(cachedInputPer1M)
    ) {
      setError(t("Enter a model and non-negative prices per million tokens."));
      return;
    }
    const offPeakRequested = [offPeakInput, offPeakOutput, offPeakCached].some((value) => value !== undefined);
    if (offPeakRequested && (!price(offPeakInput) || !price(offPeakOutput) || offPeakInput === undefined || offPeakOutput === undefined)) {
      setError(t("Off-peak rates need an input and an output price."));
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api("model-billing", {
        method: "PUT",
        body: JSON.stringify({
          model,
          inputPer1M,
          outputPer1M,
          ...(cachedInputPer1M !== undefined ? { cachedInputPer1M } : {}),
          ...(offPeakRequested
            ? {
                offPeak: {
                  inputPer1M: offPeakInput,
                  outputPer1M: offPeakOutput,
                  ...(offPeakCached !== undefined ? { cachedInputPer1M: offPeakCached } : {}),
                },
              }
            : {}),
        }),
      });
      setBilling((result?.billing ?? {}) as Record<string, DashboardModelBillingRate>);
      setForm(EMPTY_FORM);
      setNotice(t("Price saved."));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("The price could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  const edit = (model: string, rate: DashboardModelBillingRate) => {
    setForm({
      model,
      inputPer1M: String(rate.inputPer1M),
      outputPer1M: String(rate.outputPer1M),
      cachedInputPer1M: rate.cachedInputPer1M === undefined ? "" : String(rate.cachedInputPer1M),
      offPeakInputPer1M: rate.offPeak ? String(rate.offPeak.inputPer1M) : "",
      offPeakOutputPer1M: rate.offPeak ? String(rate.offPeak.outputPer1M) : "",
      offPeakCachedInputPer1M: rate.offPeak?.cachedInputPer1M === undefined
        ? ""
        : String(rate.offPeak.cachedInputPer1M),
    });
    setError("");
    setNotice("");
  };

  const remove = async (model: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api("model-billing", {
        method: "DELETE",
        body: JSON.stringify({ model }),
      });
      setBilling((result?.billing ?? {}) as Record<string, DashboardModelBillingRate>);
      setNotice(t("Price removed. The upstream rate applies again."));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("The price could not be removed."));
    } finally {
      setBusy(false);
    }
  };

  const editWindow = (
    day: DashboardOffPeakDay,
    index: number,
    field: "start" | "end",
    value: string,
  ) => {
    setSchedule((current) => ({
      ...current,
      days: {
        ...current.days,
        [day]: current.days[day].map((window, position) =>
          position === index ? { ...window, [field]: value } : window
        ),
      },
    }));
  };

  const addWindow = (day: DashboardOffPeakDay) => {
    setSchedule((current) => ({
      ...current,
      days: {
        ...current.days,
        [day]: [...current.days[day], { start: "22:00", end: "06:00" }],
      },
    }));
  };

  const removeWindow = (day: DashboardOffPeakDay, index: number) => {
    setSchedule((current) => ({
      ...current,
      days: {
        ...current.days,
        [day]: current.days[day].filter((_window, position) => position !== index),
      },
    }));
  };

  const saveSchedule = async () => {
    for (const day of DAYS) {
      for (const window of schedule.days[day]) {
        const start = window.start.trim();
        const end = window.end.trim();
        if (!start && !end) continue;
        if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start === end) {
          setScheduleError(t("Each off-peak range needs a start and an end that differ."));
          return;
        }
      }
    }
    const days: Partial<Record<DashboardOffPeakDay, Array<{ start: string; end: string }>>> = {};
    for (const day of DAYS) {
      const windows = schedule.days[day]
        .filter((window) => window.start.trim() && window.end.trim())
        .map((window) => ({ start: window.start, end: window.end }));
      if (windows.length) days[day] = windows;
    }
    setScheduleBusy(true);
    setScheduleError("");
    setScheduleNotice("");
    try {
      const result = await api("model-billing/schedule", {
        method: "PUT",
        body: JSON.stringify({
          schedule: {
            enabled: schedule.enabled,
            timezone: schedule.timezone.trim() || "UTC",
            days,
          },
        }),
      });
      setSchedule(scheduleDraft((result?.schedule ?? null) as DashboardOffPeakSchedule | null));
      setScheduleNotice(t("Off-peak schedule saved."));
    } catch {
      setScheduleError(t("The off-peak schedule could not be saved. Check the times and the timezone."));
    } finally {
      setScheduleBusy(false);
    }
  };

  return (
    <>
      <section className="panel" aria-label={t("Model pricing")}>
        <div className="section-split-header">
          <div>
            <h2>{t("Model pricing")}</h2>
            <p className="muted">
              {t("Set the amount users are billed per million tokens. Cached input can be cheaper than fresh input. Unlisted models keep the upstream estimate.")}
            </p>
          </div>
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        {notice && <div className="notice" role="status">{notice}</div>}
        <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="pricing-grid">
          <label className="control-field">
            <span className="control-label">{t("Model")}</span>
            <input
              list="model-billing-models"
              value={form.model}
              disabled={busy}
              placeholder={t("Choose or type a model id")}
              onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
            />
            <datalist id="model-billing-models">
              {models.map((model) => <option key={model} value={model} />)}
            </datalist>
          </label>
          <label className="control-field">
            <span className="control-label">{t("Input $/1M")}</span>
            <input
              type="number"
              min="0"
              step="0.000001"
              value={form.inputPer1M}
              disabled={busy}
              placeholder="2.50"
              onChange={(event) => setForm((current) => ({ ...current, inputPer1M: event.target.value }))}
            />
          </label>
          <label className="control-field">
            <span className="control-label">{t("Output $/1M")}</span>
            <input
              type="number"
              min="0"
              step="0.000001"
              value={form.outputPer1M}
              disabled={busy}
              placeholder="15.00"
              onChange={(event) => setForm((current) => ({ ...current, outputPer1M: event.target.value }))}
            />
          </label>
          <label className="control-field">
            <span className="control-label">{t("Cached input $/1M")}</span>
            <input
              type="number"
              min="0"
              step="0.000001"
              value={form.cachedInputPer1M}
              disabled={busy}
              placeholder={t("Same as input")}
              onChange={(event) => setForm((current) => ({ ...current, cachedInputPer1M: event.target.value }))}
            />
          </label>
          {/* One label per row keeps each off-peak price under its standard
              column instead of stretching across the whole width. */}
          <p className="control-label pricing-grid-group">{t("Off-peak hours")}</p>
          <label className="control-field">
            <span className="control-label">{t("Off-peak input $/1M")}</span>
            <input
              type="number"
              min="0"
              step="0.000001"
              value={form.offPeakInputPer1M}
              disabled={busy}
              placeholder={t("Same as standard")}
              onChange={(event) => setForm((current) => ({ ...current, offPeakInputPer1M: event.target.value }))}
            />
          </label>
          <label className="control-field">
            <span className="control-label">{t("Off-peak output $/1M")}</span>
            <input
              type="number"
              min="0"
              step="0.000001"
              value={form.offPeakOutputPer1M}
              disabled={busy}
              placeholder={t("Same as standard")}
              onChange={(event) => setForm((current) => ({ ...current, offPeakOutputPer1M: event.target.value }))}
            />
          </label>
          <label className="control-field">
            <span className="control-label">{t("Off-peak cached input $/1M")}</span>
            <input
              type="number"
              min="0"
              step="0.000001"
              value={form.offPeakCachedInputPer1M}
              disabled={busy}
              placeholder={t("Same as off-peak input")}
              onChange={(event) => setForm((current) => ({ ...current, offPeakCachedInputPer1M: event.target.value }))}
            />
          </label>
        </form>
        <div className="inline" style={{ gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          <button className="btn" type="button" disabled={busy || !form.model.trim()} onClick={() => void save()}>
            {busy ? t("Saving…") : form.model && billing[form.model] ? t("Update price") : t("Save price")}
          </button>
          {form.model && (
            <button className="btn ghost" type="button" disabled={busy} onClick={() => setForm(EMPTY_FORM)}>
              {t("Clear")}
            </button>
          )}
        </div>
        {configured.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>{t("No custom prices yet.")}</p>
        ) : (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("Model")}</th>
                  <th>{t("Input $/1M")}</th>
                  <th>{t("Output $/1M")}</th>
                  <th>{t("Cached input $/1M")}</th>
                  <th>{t("Off-peak $/1M")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {configured.map(([model, rate]) => (
                  <tr key={model}>
                    <td style={{ minWidth: 140 }}><code className="mono" style={{ wordBreak: "break-all" }}>{model}</code></td>
                    <td>${rate.inputPer1M}</td>
                    <td>${rate.outputPer1M}</td>
                    <td>{rate.cachedInputPer1M === undefined ? t("Same as input") : `$${rate.cachedInputPer1M}`}</td>
                    <td>
                      {rate.offPeak
                        ? `${rate.offPeak.inputPer1M} / ${rate.offPeak.outputPer1M} / ${rate.offPeak.cachedInputPer1M ?? "—"}`
                        : <span className="muted">{t("None")}</span>}
                    </td>
                    <td>
                      <div className="inline" style={{ gap: 6, whiteSpace: "nowrap" }}>
                        <button className="btn ghost" type="button" disabled={busy} onClick={() => edit(model, rate)}>
                          {t("Edit")}
                        </button>
                        <button className="btn ghost" type="button" disabled={busy} onClick={() => void remove(model)}>
                          {t("Remove")}
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

      <section className="panel" aria-label={t("Off-peak hours")}>
        <div className="section-split-header">
          <div>
            <h2>{t("Off-peak hours")}</h2>
            <p className="muted">
              {t("Inside these windows, models with off-peak rates are billed at those rates. Times use the selected timezone. A range whose end is before its start continues into the next day.")}
            </p>
          </div>
        </div>
        {scheduleError && <div className="error" role="alert">{scheduleError}</div>}
        {scheduleNotice && <div className="notice" role="status">{scheduleNotice}</div>}
        <div className="inline" style={{ gap: 16, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <label className="inline" style={{ gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={schedule.enabled}
              disabled={scheduleBusy}
              onChange={(event) => setSchedule((current) => ({ ...current, enabled: event.target.checked }))}
            />
            <span>{t("Enable off-peak pricing")}</span>
          </label>
          <label className="control-field" style={{ minWidth: 220 }}>
            <span className="control-label">{t("Timezone")}</span>
            <input
              list="off-peak-timezones"
              value={schedule.timezone}
              disabled={scheduleBusy}
              placeholder="UTC"
              onChange={(event) => setSchedule((current) => ({ ...current, timezone: event.target.value }))}
            />
            <datalist id="off-peak-timezones">
              {zones.map((zone) => <option key={zone} value={zone} />)}
            </datalist>
          </label>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          {schedule.enabled ? t("Off-peak pricing is enabled.") : t("Off-peak pricing is disabled.")}
        </p>
        <div style={{ display: "grid", gap: 10 }}>
          {DAYS.map((day) => (
            <div key={day} className="off-peak-day" style={{ display: "grid", gap: 6 }}>
              <div className="inline" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <strong style={{ minWidth: 92 }}>{t(DAY_LABEL[day])}</strong>
                <button className="btn ghost" type="button" disabled={scheduleBusy} onClick={() => addWindow(day)}>
                  {t("Add range")}
                </button>
                {schedule.days[day].length === 0 && <span className="muted">{t("No off-peak range")}</span>}
              </div>
              {schedule.days[day].map((window, index) => (
                <div key={index} className="inline" style={{ gap: 6, alignItems: "center", flexWrap: "wrap", paddingLeft: 12 }}>
                  <input
                    type="time"
                    step="60"
                    value={window.start}
                    disabled={scheduleBusy}
                    aria-label={t("Start time")}
                    style={{ width: 128 }}
                    onChange={(event) => editWindow(day, index, "start", event.target.value)}
                  />
                  <span aria-hidden="true">→</span>
                  <input
                    type="time"
                    step="60"
                    value={window.end}
                    disabled={scheduleBusy}
                    aria-label={t("End time")}
                    style={{ width: 128 }}
                    onChange={(event) => editWindow(day, index, "end", event.target.value)}
                  />
                  <button className="btn ghost" type="button" disabled={scheduleBusy} onClick={() => removeWindow(day, index)}>
                    {t("Remove")}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="inline" style={{ gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          <button className="btn" type="button" disabled={scheduleBusy} onClick={() => void saveSchedule()}>
            {scheduleBusy ? t("Saving…") : t("Save schedule")}
          </button>
        </div>
      </section>
    </>
  );
}
